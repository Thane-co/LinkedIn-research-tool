// Layer 3 — backfillColdStartHistory: the §8.6 one-time cold-start backfill.
//
// THE GAP THIS CLOSES: ~10 creators added to the roster on 2026-09-10 (e.g. shubhamsaboo,
// stevenouri, paul-storm) have zero pre-roster history — the daily scrape only captures posts
// going forward. x-factor (lib/pure/x-factor.ts) needs ~MIN_SPREAD_POSTS/MIN_RESIDUALS MATURE
// prior posts before it can score anything, so these creators sit x_provisional forever. §8.5's
// graduation pass (jobs/graduate-stuck.ts) confirmed re-reading doesn't help: there's no history
// in the DB to graduate from. This job scrapes creators' OLDER posts (deeper postedLimit) via the
// SAME actor + insert path as the daily scrape (jobs/scrape.ts / lib/db/posts.repo.insertPosts) —
// no second insert path, and no schema changes: backfilled posts are real posts, inserted the same
// way the daily scrape inserts them.
//
// COST GUARD: bills per post READ, exactly like the daily refresh/graduation pass
// (POST_SCRAPE_COST_PER_POST, $0.002/post). `maxPosts` hard-caps total posts fetched across the
// whole run (default 1500 ≈ $3, per the approved budget); `dryRun` reports which creators qualify
// and how many posts the run would fetch WITHOUT calling Apify at all.

import { recomputeXFactors } from '@/jobs/scrape'
import { buildLinkedInCreatorInput, runActor } from '@/lib/apify'
import { POST_SCRAPE_COST_PER_POST } from '@/lib/config'
import { findExistingIds, insertPosts, listColdStartAuthors, type ColdStartAuthor } from '@/lib/db/posts.repo'
import { mapApifyPostToRow } from '@/lib/pure/mappers'
import { getSettings } from '@/lib/settings'
import type { ApifyPost, PostRow } from '@/lib/types'

/** Below this many mature (>=30d old) posts, a roster author cannot ever accumulate enough
 * history for x-factor to score them (MIN_SPREAD_POSTS in lib/config.ts) — they qualify for a
 * one-time backfill. Set a little above MIN_SPREAD_POSTS (15) as a safety margin. */
export const MIN_MATURE_POSTS = 20
// Target posts fetched per qualifying creator (Basia-approved budget: ~30/creator ≈ $0.06 each).
const DEFAULT_POSTS_PER_CREATOR = 30
// Hard ceiling on total posts fetched in one run — ~$3 at $0.002/post (Basia-approved cost guard).
const DEFAULT_MAX_POSTS = 1500

export interface BackfillOptions {
  asOf?: string
  dryRun?: boolean
  /** How many older posts to request per qualifying creator (actor maxPosts). */
  postsPerCreator?: number
  /** Hard cap on total posts fetched across the whole run (cost guard). */
  maxPosts?: number
  minMaturePosts?: number
}

export interface BackfillResult {
  dryRun: boolean
  captured_on: string
  creators: string[] // qualifying creator author_ids (dry-run and real run both report this)
  creators_processed: number
  posts_fetched: number
  new_posts: number
  rescored: number
  estimated_posts: number // dry-run only: what the run WOULD fetch
  estimated_cost_usd: number // dry-run only
  cost_usd: number // real run only: what it actually cost
  errors: string[]
}

/** Map raw items to rows, dropping any item the mapper can't derive an id for (non-fatal). */
function mapItems(items: ApifyPost[], market: string): PostRow[] {
  const out: PostRow[] = []
  for (const raw of items) {
    try {
      out.push(mapApifyPostToRow(raw, market))
    } catch (err) {
      console.error(`backfillColdStartHistory: unmappable item — ${err instanceof Error ? err.message : err}`)
    }
  }
  return out
}

export async function backfillColdStartHistory(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const capturedAt = opts.asOf ?? new Date().toISOString()
  const capturedOn = capturedAt.slice(0, 10)
  const dryRun = opts.dryRun ?? false
  const postsPerCreator = opts.postsPerCreator ?? DEFAULT_POSTS_PER_CREATOR
  const maxPosts = opts.maxPosts ?? DEFAULT_MAX_POSTS
  const minMaturePosts = opts.minMaturePosts ?? MIN_MATURE_POSTS

  const qualifying: ColdStartAuthor[] = listColdStartAuthors({ asOf: capturedAt, minMaturePosts })

  const result: BackfillResult = {
    dryRun,
    captured_on: capturedOn,
    creators: qualifying.map((c) => c.author_id),
    creators_processed: 0,
    posts_fetched: 0,
    new_posts: 0,
    rescored: 0,
    estimated_posts: 0,
    estimated_cost_usd: 0,
    cost_usd: 0,
    errors: [],
  }

  if (qualifying.length === 0) {
    console.log(`backfillColdStartHistory: ${capturedOn} — no cold-start authors, nothing to do`)
    return result
  }

  if (dryRun) {
    // How many creators fit under the total cap at postsPerCreator each — report the true plan,
    // not an unbounded estimate, so the printed number matches what a real run would actually do.
    const creatorsWithinCap = Math.min(qualifying.length, Math.floor(maxPosts / postsPerCreator) || 0)
    const plannedPosts = Math.min(creatorsWithinCap * postsPerCreator, maxPosts)
    result.estimated_posts = plannedPosts
    result.estimated_cost_usd = plannedPosts * POST_SCRAPE_COST_PER_POST
    console.log(
      `backfillColdStartHistory: DRY RUN — ${qualifying.length} qualifying creator(s): ` +
        `${qualifying.map((c) => c.author_id).join(', ')}. Would fetch ~${plannedPosts} posts ` +
        `(~$${result.estimated_cost_usd.toFixed(2)}).`,
    )
    return result
  }

  const actorId = getSettings().apify_profile_actor_id
  if (!actorId) {
    throw new Error(
      'backfillColdStartHistory: no profile-posts actor configured — set apify_profile_actor_id in Settings',
    )
  }
  const market = getSettings().default_market ?? 'ai'
  const touchedAuthors = new Set<string>()
  let remainingBudget = maxPosts

  for (const author of qualifying) {
    if (remainingBudget <= 0) break

    const requestSize = Math.min(postsPerCreator, remainingBudget)
    // 'all' timeframe -> the actor's deepest postedLimit ('any'); override maxPosts down to the
    // per-creator budget so a cold-start backfill doesn't silently pull the full 500-post ceiling.
    const input = { ...buildLinkedInCreatorInput([author.profile_url], 'all'), maxPosts: requestSize }

    let items: ApifyPost[]
    try {
      items = (await runActor(actorId, input)) as ApifyPost[]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`backfillColdStartHistory: creator ${author.author_id} failed — ${message}`)
      result.errors.push(`${author.author_id}: ${message}`)
      continue
    }

    result.creators_processed++
    result.posts_fetched += items.length
    remainingBudget -= items.length

    const rows = mapItems(items, market)
    const known = findExistingIds(rows.map((r) => r.id))
    const fresh = rows.filter((r) => !known.has(r.id))
    if (fresh.length > 0) result.new_posts += insertPosts(fresh).inserted

    for (const r of rows) if (r.author_id) touchedAuthors.add(r.author_id)
  }

  try {
    result.rescored = recomputeXFactors([...touchedAuthors])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`backfillColdStartHistory: x-factor recompute failed — ${message}`)
    result.errors.push(`recompute: ${message}`)
  }

  result.cost_usd = result.posts_fetched * POST_SCRAPE_COST_PER_POST
  console.log(
    `backfillColdStartHistory: ${capturedOn} — ${result.creators_processed} creator(s) processed, ` +
      `${result.posts_fetched} posts read, ${result.new_posts} new, ${result.rescored} rescored, ` +
      `$${result.cost_usd.toFixed(2)}, ${result.errors.length} error(s)`,
  )
  return result
}
