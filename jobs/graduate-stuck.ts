// Layer 3 — graduateStuckPosts: the §8 graduation pass.
//
// THE GAP THIS CLOSES (diagnosed 2026-09-26): a post measured only while young (<MATURITY_DAYS
// after posting) keeps `x_provisional=1` and stale counts FOREVER if it then slips out of the
// daily refresh's 'week' window — the refresh never looks back further, so the post never gets a
// mature measurement and never earns a score. 61 of 63 roster creators had such gaps; recently
// added creators had zero scored posts. The invariant "recompute runs after every scrape AND
// every engagement refresh" was firing, but on measurements that never matured.
//
// This job finds roster authors with stuck posts aged [MATURITY_DAYS, GRADUATION_WINDOW_DAYS],
// re-reads their recent posts once (same actor + input shape as the daily refresh), snapshots,
// refreshes counts, and recomputes — giving every stuck post its first MATURE measurement.
// `maxAuthors` caps the Apify spend per run (Basia-approved cost guard); the remainder is
// reported and heals on subsequent runs.
//
// COST: bills per result item, like the refresh. A run with zero stuck authors makes zero actor
// calls and costs nothing — steady state once the backlog drains.

import { buildLinkedInCreatorInput, runActor } from '@/lib/apify'
import { ENGAGEMENT_REFRESH_TIMEFRAME, MATURITY_DAYS, POST_SCRAPE_COST_PER_POST } from '@/lib/config'
import { recordPostSnapshots, type NewPostSnapshot } from '@/lib/db/post-snapshots.repo'
import { findExistingIds, insertPosts, listStuckAuthors, refreshEngagement } from '@/lib/db/posts.repo'
import { recomputeXFactors } from '@/jobs/scrape'
import { mapApifyPostToRow } from '@/lib/pure/mappers'
import { getSettings } from '@/lib/settings'
import type { ApifyPost, PostRow } from '@/lib/types'

/** Posts older than this are left alone: too old to be worth a paid re-read (cost guard). */
export const GRADUATION_WINDOW_DAYS = 30
const DEFAULT_MAX_AUTHORS = 25
const BATCH_SIZE = 25

export interface GraduateResult {
  captured_on: string
  authors: number
  remaining_authors: number
  posts_returned: number
  snapshots: number
  new_posts: number
  rescored: number
  cost_usd: number
  errors: string[]
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function graduateStuckPosts(
  opts: { asOf?: string; maxAuthors?: number } = {},
): Promise<GraduateResult> {
  const capturedAt = opts.asOf ?? new Date().toISOString()
  const capturedOn = capturedAt.slice(0, 10)
  const maxAuthors = opts.maxAuthors ?? DEFAULT_MAX_AUTHORS

  const stuck = listStuckAuthors({
    asOf: capturedAt,
    minAgeDays: MATURITY_DAYS,
    maxAgeDays: GRADUATION_WINDOW_DAYS,
  })
  const selected = stuck.slice(0, maxAuthors)

  const result: GraduateResult = {
    captured_on: capturedOn,
    authors: selected.length,
    remaining_authors: stuck.length - selected.length,
    posts_returned: 0,
    snapshots: 0,
    new_posts: 0,
    rescored: 0,
    cost_usd: 0,
    errors: [],
  }
  if (selected.length === 0) {
    console.log(`graduateStuckPosts: ${capturedOn} — no stuck authors, nothing to do`)
    return result
  }

  const actorId = getSettings().apify_profile_actor_id
  if (!actorId) {
    throw new Error(
      'graduateStuckPosts: no profile-posts actor configured — set apify_profile_actor_id in Settings',
    )
  }
  const market = getSettings().default_market ?? 'ai'
  const touchedAuthors = new Set<string>()

  for (const batch of chunk(selected, BATCH_SIZE)) {
    let items: ApifyPost[]
    try {
      items = (await runActor(
        actorId,
        buildLinkedInCreatorInput(batch.map((a) => a.profile_url), ENGAGEMENT_REFRESH_TIMEFRAME),
      )) as ApifyPost[]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`graduateStuckPosts: batch of ${batch.length} failed — ${message}`)
      result.errors.push(`batch of ${batch.length}: ${message}`)
      continue
    }
    result.posts_returned += items.length

    const rows: PostRow[] = []
    for (const item of items) {
      try {
        rows.push(mapApifyPostToRow(item, market))
      } catch (err) {
        console.error(`graduateStuckPosts: unmappable item — ${err instanceof Error ? err.message : err}`)
      }
    }
    if (rows.length === 0) continue

    const known = findExistingIds(rows.map((r) => r.id))
    const fresh = rows.filter((r) => !known.has(r.id))
    if (fresh.length > 0) result.new_posts += insertPosts(fresh).inserted

    refreshEngagement(
      rows
        .filter((r) => known.has(r.id))
        .map((r) => ({ id: r.id, likes: r.likes, shares: r.shares, comments: r.comments })),
    )

    const snapshots: NewPostSnapshot[] = rows.map((r) => ({
      post_id: r.id,
      captured_on: capturedOn,
      captured_at: capturedAt,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
    }))
    result.snapshots += recordPostSnapshots(snapshots)

    for (const r of rows) if (r.author_id) touchedAuthors.add(r.author_id)
  }

  try {
    result.rescored = recomputeXFactors([...touchedAuthors])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`graduateStuckPosts: x-factor recompute failed — ${message}`)
    result.errors.push(`recompute: ${message}`)
  }

  result.cost_usd = result.posts_returned * POST_SCRAPE_COST_PER_POST
  console.log(
    `graduateStuckPosts: ${capturedOn} — ${result.authors} authors (${result.remaining_authors} deferred), ` +
      `${result.posts_returned} posts read, ${result.snapshots} snapshots, ${result.rescored} rescored, ` +
      `$${result.cost_usd.toFixed(2)}, ${result.errors.length} error(s)`,
  )
  return result
}
