// Layer 3 — refreshRecentEngagement: re-read every roster creator's recent posts and append today's
// engagement to each post's time series (PRD §22).
//
// This is the loop that turns `posts` from a snapshot of "how did it do" into a curve of "how did it
// GROW". `posts` keeps the latest numbers (so the dashboard is current); `post_snapshots` keeps the
// history (so day 1 can be compared with day 2 and day 3).
//
// COST NOTE, because this is the expensive job: the actor bills per RESULT ITEM, so every re-read of
// an already-known post is paid for again. That is inherent to the design — you cannot measure a
// curve without re-measuring — but it means the window is the cost lever, and the result reports
// `cost_usd` so a run is never a surprise on the invoice.
//
// A failed batch is logged and skipped, never fatal: losing one batch is a gap in the curve, while
// aborting would lose the whole day's measurements for everyone.

import { buildLinkedInCreatorInput, runActor } from '@/lib/apify'
import { ENGAGEMENT_REFRESH_TIMEFRAME, POST_SCRAPE_COST_PER_POST } from '@/lib/config'
import { listCreators } from '@/lib/db/creators.repo'
import { recordPostSnapshots, type NewPostSnapshot } from '@/lib/db/post-snapshots.repo'
import { findExistingIds, insertPosts, refreshEngagement } from '@/lib/db/posts.repo'
import { recomputeXFactors } from '@/jobs/scrape'
import { mapApifyPostToRow } from '@/lib/pure/mappers'
import { getSettings } from '@/lib/settings'
import type { ApifyPost, PostRow } from '@/lib/types'

const DEFAULT_BATCH_SIZE = 25

export interface RefreshResult {
  captured_on: string
  creators: number
  posts_returned: number
  snapshots: number
  new_posts: number
  /** §8: posts whose x-factor was recomputed after the refresh (scores go stale otherwise). */
  rescored: number
  cost_usd: number
  errors: string[]
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Re-read the roster's recent posts as of `asOf` (an ISO instant, defaulting to now) and append a
 * snapshot per post. Throws only when no actor is configured; a failed batch is reported, not thrown.
 */
export async function refreshRecentEngagement(
  opts: { asOf?: string; batchSize?: number } = {},
): Promise<RefreshResult> {
  const capturedAt = opts.asOf ?? new Date().toISOString()
  const capturedOn = capturedAt.slice(0, 10)
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE

  const actorId = getSettings().apify_profile_actor_id
  if (!actorId) {
    throw new Error(
      'refreshRecentEngagement: no profile-posts actor configured — set apify_profile_actor_id in Settings',
    )
  }

  const market = getSettings().default_market ?? 'ai'
  const roster = listCreators({ platform: 'linkedin' }).creators
  const result: RefreshResult = {
    captured_on: capturedOn,
    creators: roster.length,
    posts_returned: 0,
    snapshots: 0,
    new_posts: 0,
    rescored: 0,
    cost_usd: 0,
    errors: [],
  }
  if (roster.length === 0) return result

  // Authors whose posts had counts refreshed or new posts inserted this run — the exact scope the
  // x-factor recompute must cover, since their weighted_score (and thus their baselines) just moved.
  const touchedAuthors = new Set<string>()

  for (const batch of chunk(roster, batchSize)) {
    let items: ApifyPost[]
    try {
      items = (await runActor(
        actorId,
        buildLinkedInCreatorInput(batch.map((c) => c.profile_url), ENGAGEMENT_REFRESH_TIMEFRAME),
      )) as ApifyPost[]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`refreshRecentEngagement: batch of ${batch.length} failed — ${message}`)
      result.errors.push(`batch of ${batch.length}: ${message}`)
      continue
    }

    result.posts_returned += items.length

    const rows: PostRow[] = []
    for (const item of items) {
      try {
        rows.push(mapApifyPostToRow(item, market))
      } catch (err) {
        // An unmappable item (no derivable id) is skipped loudly, never silently.
        console.error(`refreshRecentEngagement: unmappable item — ${err instanceof Error ? err.message : err}`)
      }
    }
    if (rows.length === 0) continue

    // A post the roster produced that we have never stored is inserted, not discarded: we already
    // paid for it, and dropping it would leave a hole in the corpus the search can never fill.
    const known = findExistingIds(rows.map((r) => r.id))
    const fresh = rows.filter((r) => !known.has(r.id))
    if (fresh.length > 0) result.new_posts += insertPosts(fresh).inserted

    // Known posts get their live numbers refreshed in place (the dashboard reads `posts`).
    refreshEngagement(
      rows
        .filter((r) => known.has(r.id))
        .map((r) => ({ id: r.id, likes: r.likes, shares: r.shares, comments: r.comments })),
    )

    // Every post — new or known — gets today's measurement appended to its curve.
    const snapshots: NewPostSnapshot[] = rows.map((r) => ({
      post_id: r.id,
      captured_on: capturedOn,
      captured_at: capturedAt,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
    }))
    result.snapshots += recordPostSnapshots(snapshots)

    // Track the authors this batch touched so the recompute below is scoped to them, not the whole DB.
    for (const r of rows) if (r.author_id) touchedAuthors.add(r.author_id)
  }

  // The bug this fixes: refreshEngagement rewrites likes/comments/shares in place but never recomputes
  // scores, so x_factor/x_score on refreshed posts go stale. Recompute now, scoped to the authors just
  // touched. Non-fatal: a recompute failure must not lose the day's snapshots (already committed above).
  try {
    result.rescored = recomputeXFactors([...touchedAuthors])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`refreshRecentEngagement: x-factor recompute failed — ${message}`)
    result.errors.push(`recompute: ${message}`)
  }

  result.cost_usd = result.posts_returned * POST_SCRAPE_COST_PER_POST
  console.log(
    `refreshRecentEngagement: ${capturedOn} — ${result.posts_returned} posts read, ` +
      `${result.snapshots} snapshots, ${result.new_posts} new, ${result.rescored} rescored, ` +
      `$${result.cost_usd.toFixed(2)}, ${result.errors.length} batch error(s)`,
  )
  return result
}
