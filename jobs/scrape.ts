// Layer 3 — runScrape orchestration + recomputeXFactors (PRD §10.5, §8.4, §12 step 21).
// TDD: both scrapers run in parallel; stats incl. duplicate/both counts; one scraper empty still
// completes; both fail -> job 'failed'; x-factor recompute scoped to affected authors; recompute
// matches on author_id NOT author_url.

import { enrichPosts } from '@/jobs/enrich'
import { transcribeInstagramVideos } from '@/jobs/transcribe'
import { TIMEFRAME_DAYS } from '@/lib/config'
import {
  buildInstagramCreatorInput,
  buildLinkedInCreatorInput,
  buildLinkedInKeywordInput,
  buildSubstackCreatorInput,
  buildSubstackKeywordInput,
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
import {
  isSubstackContent,
  mapApifyInstagramToRow,
  mapApifyPostToRow,
  mapApifySubstackToRow,
  mapApifyTweetToRow,
} from '@/lib/pure/mappers'
import { computeXFactor, weightedScore } from '@/lib/pure/x-factor'
import { getSettings } from '@/lib/settings'
import { fetchSubstackNoteContent } from '@/lib/substack'
import type {
  ApifyInstagramPost,
  ApifyPost,
  ApifySubstackPost,
  ApifyTweet,
  Platform,
  PostRow,
  ScrapeStats,
  Timeframe,
} from '@/lib/types'

type RawItem = ApifyPost | ApifyTweet | ApifySubstackPost | ApifyInstagramPost

export interface RunScrapeOptions {
  platforms: Platform[]
  mode: 'keyword' | 'creator' | 'both'
  keywords?: string[]
  creatorIds?: string[]
  timeframe: Timeframe
  market: string
  includeNotes?: boolean // Substack: also scrape the Notes feed (§17). Off by default.
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
// Transcribe up to this many Instagram videos per scrape (§18) — bounded so a single transcript actor
// run stays within the poll ceiling; the /api/transcribe route drains the rest in further batches.
const TRANSCRIBE_LIMIT = 25
const DAY_MS = 24 * 60 * 60 * 1000

// Substack's actor bounds by an absolute date (dateFrom), not a relative enum — so compute the cutoff
// here (Layer 3 may read the clock; the pure builders stay time-free). Returns a YYYY-MM-DD string, or
// undefined for 'all'/'custom' (no bound). Mirrors the LinkedIn creator postedLimit so a "week" scrape
// only fetches the last week and doesn't re-pay for older posts (§17).
function timeframeDateFrom(timeframe: Timeframe): string | undefined {
  const days = (TIMEFRAME_DAYS as Record<string, number>)[timeframe]
  if (!days) return undefined
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
}
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
    } else if (platform === 'twitter') {
      // Twitter uses ONE actor for both modes; only the input shape differs (CLAUDE.md invariant).
      const tweetActor = settings.apify_tweet_actor_id
      if (wantKeyword && keywords.length > 0 && tweetActor) {
        runs.push({ source: 'keyword', platform, actorId: tweetActor, input: buildTwitterKeywordInput(keywords) })
      }
      const handles = creators.filter((c) => c.platform === 'twitter').map((c) => c.author_id).filter((h): h is string => !!h)
      if (wantCreator && handles.length > 0 && tweetActor) {
        runs.push({ source: 'creator', platform, actorId: tweetActor, input: buildTwitterCreatorInput(handles) })
      }
    } else if (platform === 'instagram') {
      // Instagram uses the post scraper in CREATOR mode only (§18) — it's profile-driven, no keyword
      // search. Target by profile url (the actor's `username` field accepts urls or handles).
      // onlyNewerThan bounds the fetch by date so a short timeframe doesn't re-pull old posts.
      const igActor = settings.apify_instagram_actor_id
      const targets = creators.filter((c) => c.platform === 'instagram').map((c) => c.profile_url)
      if (wantCreator && targets.length > 0 && igActor) {
        runs.push({ source: 'creator', platform, actorId: igActor, input: buildInstagramCreatorInput(targets, opts.timeframe, { onlyNewerThan: timeframeDateFrom(opts.timeframe) }) })
      }
    } else {
      // Substack likewise uses ONE actor for both modes (§17.1); creator mode targets publication urls.
      // dateFrom bounds the fetch by date so a short timeframe doesn't re-pull old posts.
      const substackActor = settings.apify_substack_actor_id
      const dateFrom = timeframeDateFrom(opts.timeframe)
      if (wantKeyword && keywords.length > 0 && substackActor) {
        runs.push({ source: 'keyword', platform, actorId: substackActor, input: buildSubstackKeywordInput(keywords, opts.timeframe, { dateFrom }) })
      }
      // Target publications by their bare handle (author_id), NOT the profile url — the actor scrapes
      // publications, and a substack.com/@handle profile url returns nothing (§17.1).
      const handles = creators.filter((c) => c.platform === 'substack').map((c) => c.author_id).filter((h): h is string => !!h)
      if (wantCreator && handles.length > 0 && substackActor) {
        runs.push({ source: 'creator', platform, actorId: substackActor, input: buildSubstackCreatorInput(handles, opts.timeframe, { dateFrom, includeNotes: opts.includeNotes }) })
      }
    }
  }
  return runs
}

const NOTE_BACKFILL_CONCURRENCY = 6

/** A Substack note row that carries nothing to render even after backfill (drop it, don't insert). */
function isDeadNote(r: PostRow): boolean {
  return r.id.startsWith('substack-note-') && !r.content && !r.image_url
}

/**
 * Backfill Substack notes the actor returned empty (post-share / quote notes) from the public reader
 * API (§17): pull the referenced article's title/subtitle/cover/url onto the row. Concurrency-limited
 * and fully non-fatal — a note that can't be backfilled stays empty and is dropped by isDeadNote.
 */
async function backfillEmptySubstackNotes(rows: PostRow[]): Promise<void> {
  const empties = rows.filter((r) => r.id.startsWith('substack-note-') && !r.content && !r.image_url)
  for (let i = 0; i < empties.length; i += NOTE_BACKFILL_CONCURRENCY) {
    await Promise.all(
      empties.slice(i, i + NOTE_BACKFILL_CONCURRENCY).map(async (r) => {
        const enr = await fetchSubstackNoteContent(r.id.replace('substack-note-', ''))
        if (!enr) return
        if (enr.content) r.content = enr.content
        if (enr.imageUrl) {
          r.image_url = enr.imageUrl
          r.media = JSON.stringify({ type: 'image', images: [enr.imageUrl] })
        }
        // note keeps its own url (r.url) — the article's url would collide with the scraped post
      }),
    )
  }
}

/** Map one raw item to a PostRow by platform (throws on missing id — caught by the caller). */
function mapItem(raw: RawItem, platform: Platform, market: string): PostRow {
  switch (platform) {
    case 'linkedin':
      return mapApifyPostToRow(raw as ApifyPost, market)
    case 'twitter':
      return mapApifyTweetToRow(raw as ApifyTweet, market)
    case 'instagram':
      return mapApifyInstagramToRow(raw as ApifyInstagramPost, market)
    default:
      return mapApifySubstackToRow(raw as ApifySubstackPost, market)
  }
}

/** Map a raw dataset to rows: skip non-English and any item without a derivable id (non-fatal). */
function mapItems(items: RawItem[], platform: Platform, market: string): PostRow[] {
  const out: PostRow[] = []
  for (const raw of items) {
    // Substack's userHandles input also returns author/publication metadata records — skip those;
    // they carry no post content and would land as blank rows (§17). Empty notes are NOT skipped here:
    // they may be post-share/quote notes we can backfill from the reader API (backfillEmptySubstackNotes).
    if (platform === 'substack' && !isSubstackContent(raw as ApifySubstackPost)) continue
    try {
      const row = mapItem(raw, platform, market)
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
          return { run, ok: false as const, items: [] as RawItem[], error: err as Error }
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

    // Backfill empty Substack notes (post-share/quote notes) from the reader API, then drop any note
    // that is still blank afterward — so no empty note cards, and shares/quotes show their article.
    await backfillEmptySubstackNotes(creatorRows)
    const keywordClean = keywordRows.filter((r) => !isDeadNote(r))
    const creatorClean = creatorRows.filter((r) => !isDeadNote(r))

    const { posts, duplicates, foundInBoth } = mergeAndDeduplicate(keywordClean, creatorClean)
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

    // Transcribe Instagram videos (§18) — runs whenever the scrape touched Instagram, even with 0 new
    // inserts, so it also backfills any earlier video posts still missing a transcript. Non-fatal.
    if (opts.platforms.includes('instagram')) {
      try {
        await transcribeInstagramVideos(TRANSCRIBE_LIMIT)
      } catch (err) {
        console.error('scrape: instagram transcribe failed:', (err as Error).message)
      }
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
