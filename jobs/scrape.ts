// Layer 3 — runScrape orchestration + recomputeXFactors (PRD §10.5, §8.4, §12 step 21).
// TDD: both scrapers run in parallel; stats incl. duplicate/both counts; one scraper empty still
// completes; both fail -> job 'failed'; x-factor recompute scoped to affected authors; recompute
// matches on author_id NOT author_url.

import { enrichPosts } from '@/jobs/enrich'
import {
  buildLinkedInCreatorInput,
  buildLinkedInKeywordInput,
  buildTwitterCreatorInput,
  buildTwitterKeywordInput,
  runActor,
} from '@/lib/apify'
import { listCreators } from '@/lib/db/creators.repo'
import { createJob, finishJob } from '@/lib/db/jobs.repo'
import {
  findExistingIds,
  getAuthorHistory,
  insertPosts,
  updateXFactor,
} from '@/lib/db/posts.repo'
import { mergeAndDeduplicate } from '@/lib/pure/dedup'
import { isLikelyNonEnglish } from '@/lib/pure/lang'
import { mapApifyPostToRow, mapApifyTweetToRow } from '@/lib/pure/mappers'
import { computeXFactor, weightedScore } from '@/lib/pure/x-factor'
import { getSettings } from '@/lib/settings'
import type { ApifyPost, ApifyTweet, Platform, PostRow, ScrapeStats, Timeframe } from '@/lib/types'

export interface RunScrapeOptions {
  platforms: Platform[]
  mode: 'keyword' | 'creator' | 'both'
  keywords?: string[]
  creatorIds?: string[]
  timeframe: Timeframe
  market: string
  // The API route creates the scrape_jobs row up front so it can return the id immediately (PRD
  // §10.6) and then fire runScrape without awaiting. When absent, runScrape creates its own job.
  jobId?: string
}

type RunSource = 'keyword' | 'creator'
interface ActorRun {
  source: RunSource
  platform: Platform
  actorId: string
  input: object
}

// Drain up to this many unembedded posts after a scrape (Voyage batches internally at 100).
const ENRICH_LIMIT = 200
const ZERO_STATS: ScrapeStats = {
  keyword_raw: 0,
  creator_raw: 0,
  merged_total: 0,
  duplicates: 0,
  found_in_both: 0,
  inserted: 0,
}

/** Resolve which actor runs are needed for the requested platforms/mode (PRD §10.5 step 2). */
function planRuns(opts: RunScrapeOptions): ActorRun[] {
  const settings = getSettings()
  const wantKeyword = opts.mode === 'keyword' || opts.mode === 'both'
  const wantCreator = opts.mode === 'creator' || opts.mode === 'both'
  const keywords = opts.keywords ?? []

  // Resolve creator targets once: an explicit id list, else every 'core' creator (PRD §10.5).
  let creators: { platform: Platform; profile_url: string; author_id: string | null }[] = []
  if (wantCreator) {
    const all = listCreators().creators
    creators = (
      opts.creatorIds?.length ? all.filter((c) => opts.creatorIds!.includes(c.id)) : all.filter((c) => c.tier === 'core')
    ).map((c) => ({ platform: c.platform, profile_url: c.profile_url, author_id: c.author_id }))
  }

  const runs: ActorRun[] = []
  for (const platform of opts.platforms) {
    if (platform === 'linkedin') {
      const keywordActor = settings.apify_keyword_actor_id
      if (wantKeyword && keywords.length > 0 && keywordActor) {
        runs.push({ source: 'keyword', platform, actorId: keywordActor, input: buildLinkedInKeywordInput(keywords, opts.timeframe) })
      }
      const profileActor = settings.apify_profile_actor_id
      const urls = creators.filter((c) => c.platform === 'linkedin').map((c) => c.profile_url)
      if (wantCreator && urls.length > 0 && profileActor) {
        runs.push({ source: 'creator', platform, actorId: profileActor, input: buildLinkedInCreatorInput(urls, opts.timeframe) })
      }
    } else {
      // Twitter uses ONE actor for both modes; only the input shape differs (CLAUDE.md invariant).
      const tweetActor = settings.apify_tweet_actor_id
      if (wantKeyword && keywords.length > 0 && tweetActor) {
        runs.push({ source: 'keyword', platform, actorId: tweetActor, input: buildTwitterKeywordInput(keywords) })
      }
      const handles = creators.filter((c) => c.platform === 'twitter').map((c) => c.author_id).filter((h): h is string => !!h)
      if (wantCreator && handles.length > 0 && tweetActor) {
        runs.push({ source: 'creator', platform, actorId: tweetActor, input: buildTwitterCreatorInput(handles) })
      }
    }
  }
  return runs
}

/** Map a raw dataset to rows: skip non-English and any item without a derivable id (non-fatal). */
function mapItems(items: (ApifyPost | ApifyTweet)[], platform: Platform, market: string): PostRow[] {
  const out: PostRow[] = []
  for (const raw of items) {
    try {
      const row =
        platform === 'linkedin'
          ? mapApifyPostToRow(raw as ApifyPost, market)
          : mapApifyTweetToRow(raw as ApifyTweet, market)
      if (isLikelyNonEnglish(row.content)) continue
      out.push(row)
    } catch (err) {
      console.warn('scrape: skipping unmappable item:', (err as Error).message)
    }
  }
  return out
}

/**
 * Full scrape pipeline (PRD §10.5): create job -> run needed actors in parallel (per-run catch) ->
 * map -> merge/dedup -> insert -> recomputeXFactors + enrich (both non-fatal) -> finalize job.
 * The route calls this without awaiting (PRD §10.6), so it owns its own job status transitions.
 */
export async function runScrape(opts: RunScrapeOptions): Promise<ScrapeStats> {
  const jobId =
    opts.jobId ??
    createJob({
      mode: opts.mode,
      platforms: opts.platforms,
      market: opts.market,
      params: { timeframe: opts.timeframe, keywords: opts.keywords ?? [], creatorIds: opts.creatorIds ?? [] },
    }).id

  try {
    const runs = planRuns(opts)

    // Run every actor in parallel; a single failure records raw=0 and must not abort the others.
    const settled = await Promise.all(
      runs.map(async (run) => {
        try {
          const items = await runActor(run.actorId, run.input)
          return { run, ok: true as const, items }
        } catch (err) {
          console.error(`scrape: actor ${run.actorId} (${run.platform}/${run.source}) failed:`, (err as Error).message)
          return { run, ok: false as const, items: [] as (ApifyPost | ApifyTweet)[], error: err as Error }
        }
      }),
    )

    // Every needed scraper failed -> the whole run failed (PRD §12 step 21).
    if (runs.length > 0 && settled.every((r) => !r.ok)) {
      const error = settled.map((r) => (r.ok ? '' : r.error.message)).filter(Boolean).join('; ')
      finishJob(jobId, { status: 'failed', error: error || 'all scrapers failed' })
      return ZERO_STATS
    }

    const keywordRows: PostRow[] = []
    const creatorRows: PostRow[] = []
    let keyword_raw = 0
    let creator_raw = 0
    for (const r of settled) {
      if (!r.ok) continue
      if (r.run.source === 'keyword') keyword_raw += r.items.length
      else creator_raw += r.items.length
      const mapped = mapItems(r.items, r.run.platform, opts.market)
      ;(r.run.source === 'keyword' ? keywordRows : creatorRows).push(...mapped)
    }

    const { posts, duplicates, foundInBoth } = mergeAndDeduplicate(keywordRows, creatorRows)
    const existing = findExistingIds(posts.map((p) => p.id))
    const newRows = posts.filter((p) => !existing.has(p.id))
    const { inserted } = insertPosts(newRows)

    const stats: ScrapeStats = {
      keyword_raw,
      creator_raw,
      merged_total: posts.length,
      duplicates,
      found_in_both: foundInBoth,
      inserted,
    }
    finishJob(jobId, { status: 'succeeded', stats })

    // --- non-fatal follow-on jobs (PRD §10.5 step 6): enrich, then recompute. Neither may bubble
    // up to fail the scrape (the job is already 'succeeded'). ------------------------------------
    if (inserted > 0) {
      try {
        await enrichPosts(ENRICH_LIMIT)
      } catch (err) {
        console.error('scrape: enrich failed:', (err as Error).message)
      }
    }
    const affectedAuthors = [...new Set(newRows.map((p) => p.author_id).filter((a): a is string => !!a))]
    try {
      recomputeXFactors(affectedAuthors)
    } catch (err) {
      console.error('scrape: x-factor recompute failed:', (err as Error).message)
    }

    return stats
  } catch (err) {
    finishJob(jobId, { status: 'failed', error: (err as Error).message })
    throw err
  }
}

/**
 * Recompute weighted_score / creator_baseline / x_factor for the given authors only (PRD §8.4).
 * Match strictly on author_id (clean slug/handle), never on author_url (which may carry
 * ?miniProfileUrn=… query strings that break equality). Non-fatal per author.
 */
export function recomputeXFactors(authorIds: string[]): void {
  const distinct = [...new Set(authorIds.filter((a): a is string => !!a))]
  for (const authorId of distinct) {
    try {
      // getAuthorHistory matches strictly on author_id (never author_url) — the original bug fix.
      const scored = getAuthorHistory(authorId).map((post) => ({ post, ws: weightedScore(post) }))
      for (const { post, ws } of scored) {
        if (!post.posted_at) {
          updateXFactor(post.id, { weighted_score: ws, creator_baseline: null, x_factor: null })
          continue
        }
        const priors = scored
          .filter((s) => s.post.id !== post.id && s.post.posted_at)
          .map((s) => ({ weighted_score: s.ws, posted_at: s.post.posted_at as string }))
        const { creator_baseline, x_factor } = computeXFactor({ weighted_score: ws, posted_at: post.posted_at }, priors)
        updateXFactor(post.id, { weighted_score: ws, creator_baseline, x_factor })
      }
    } catch (err) {
      console.error(`recomputeXFactors: failed for author ${authorId}:`, (err as Error).message)
    }
  }
}
