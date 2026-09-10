// Layer 3 — the one leaderboard implementation (§21), shared by /api/followers and /api/v1/followers
// exactly as runPostsQuery() is shared by the dashboard and the agent API. Composition only: the
// storage lives in lib/db/followers.repo.ts, the math in lib/pure/follower-growth.ts.

import { FOLLOWER_PERCENT_FLOOR } from '@/lib/config'
import { listCreators } from '@/lib/db/creators.repo'
import { getDb } from '@/lib/db/db'
import { getSnapshots, getSnapshotsSince, latestSnapshotDay } from '@/lib/db/followers.repo'
import {
  attributeDay,
  dailyDeltas,
  rankLeaderboard,
  windowGrowth,
  type DayAttribution,
  type GrowthEntry,
  type RankedEntry,
  type Snapshot,
} from '@/lib/pure/follower-growth'

const DAY_MS = 24 * 60 * 60 * 1000

/** 'YYYY-MM-DD' n days before a day key. */
function dayKeyBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The window's baseline may fall back to a snapshot OLDER than the window start when that exact day
 * was never captured, so the fetch reaches further back than the window itself. 30 days of slack
 * covers a long capture outage without loading the whole series for every creator.
 */
const BASELINE_SLACK_DAYS = 30

interface PostWindowStats {
  posts: number
  best_x_factor: number | null
}

/** Post count + best x-factor per author inside [from, to], in one grouped query rather than N. */
function postStatsByAuthor(fromDay: string, toDay: string): Map<string, PostWindowStats> {
  const rows = getDb()
    .prepare(
      `SELECT author_id, COUNT(*) AS posts, MAX(x_factor) AS best_x_factor
       FROM posts
       WHERE platform = 'linkedin' AND author_id IS NOT NULL
         AND posted_at >= ? AND posted_at < ?
       GROUP BY author_id`,
    )
    .all(`${fromDay}T00:00:00.000Z`, `${toDay}T23:59:59.999Z`) as {
    author_id: string
    posts: number
    best_x_factor: number | null
  }[]

  return new Map(rows.map((r) => [r.author_id, { posts: r.posts, best_x_factor: r.best_x_factor }]))
}

/** A ranked row plus the follower series behind it, so the board draws sparklines from one call. */
export type BoardRow = RankedEntry & { spark: number[] }

export interface Leaderboard {
  as_of: string
  window_days: number
  percent_floor: number
  absolute: BoardRow[]
  percent: BoardRow[]
  coverage: { creators: number; measured: number }
}

/**
 * Both champion boards over the last `windowDays`.
 *
 * `asOf` defaults to the newest day actually captured, not today: after a missed run, a board keyed
 * to today would compare a stale latest snapshot against a stale baseline and quietly report zeros.
 * Every core LinkedIn creator appears on the absolute board whether or not they have been measured —
 * unmeasured rows carry `gained: null` and sort last, never a fabricated 0.
 */
export function buildLeaderboard({
  windowDays,
  asOf,
  percentFloor = FOLLOWER_PERCENT_FLOOR,
}: {
  windowDays: number
  asOf?: string
  percentFloor?: number
}): Leaderboard {
  const day = asOf ?? latestSnapshotDay('linkedin') ?? new Date().toISOString().slice(0, 10)
  // §21.8 — the board mirrors the capture: the tracked subset only. A research-only creator has no
  // series and would sit on the board as a permanent em dash.
  const creators = listCreators({ platform: 'linkedin', tracked: true }).creators.filter((c) => c.author_id)
  const series = getSnapshotsSince('linkedin', dayKeyBefore(day, windowDays + BASELINE_SLACK_DAYS))
  const stats = postStatsByAuthor(dayKeyBefore(day, windowDays), day)

  const entries: (GrowthEntry & { spark: number[] })[] = creators.map((c) => {
    const authorId = c.author_id as string
    const growth = windowGrowth(series.get(authorId) ?? [], { windowDays, asOf: day })
    const stat = stats.get(authorId)
    const own = series.get(authorId) ?? []
    return {
      spark: own.map((s) => s.followers),
      author_id: authorId,
      display_name: c.display_name,
      avatar_url: c.avatar_url,
      followers: growth?.followers ?? own.at(-1)?.followers ?? 0,
      gained: growth?.gained ?? null,
      percent: growth?.percent ?? null,
      stale: growth?.stale ?? false,
      approx: growth?.approx ?? false,
      posts: stat?.posts ?? 0,
      best_x_factor: stat?.best_x_factor ?? null,
    }
  })

  const { absolute, percent } = rankLeaderboard(entries, { percentFloor })
  return {
    as_of: day,
    window_days: windowDays,
    percent_floor: percentFloor,
    absolute,
    percent,
    coverage: { creators: entries.length, measured: entries.filter((e) => e.gained !== null).length },
  }
}

export interface CreatorGrowthDay extends DayAttribution {
  captured_on: string
  followers: number
  percent: number | null
}

export interface CreatorGrowthDetail {
  author_id: string
  series: Snapshot[]
  days: CreatorGrowthDay[]
}

/**
 * One creator's history: the raw series (the sparkline) and the per-day deltas with their posts
 * attached. A day with several posts reports the growth on the DAY and refuses to split it between
 * them (see attributeDay) — a fabricated split would be indistinguishable from a measurement.
 */
export function creatorGrowthDetail(
  authorId: string,
  { days = 30, asOf }: { days?: number; asOf?: string } = {},
): CreatorGrowthDetail {
  const day = asOf ?? latestSnapshotDay('linkedin') ?? new Date().toISOString().slice(0, 10)
  const from = dayKeyBefore(day, days)
  const series = getSnapshots(authorId, 'linkedin').filter((s) => s.captured_on >= from && s.captured_on <= day)

  const posts = getDb()
    .prepare(
      `SELECT id, substr(posted_at, 1, 10) AS day, x_factor FROM posts
       WHERE platform = 'linkedin' AND author_id = ? AND posted_at >= ? AND posted_at <= ?
       ORDER BY posted_at ASC`,
    )
    .all(authorId, `${from}T00:00:00.000Z`, `${day}T23:59:59.999Z`) as {
    id: string
    day: string
    x_factor: number | null
  }[]

  const byDay = new Map<string, { id: string; x_factor: number | null }[]>()
  for (const p of posts) {
    const list = byDay.get(p.day)
    if (list) list.push({ id: p.id, x_factor: p.x_factor })
    else byDay.set(p.day, [{ id: p.id, x_factor: p.x_factor }])
  }

  return {
    author_id: authorId,
    series,
    days: dailyDeltas(series).map((d) => ({
      captured_on: d.captured_on,
      followers: d.followers,
      percent: d.percent,
      ...attributeDay(d.gained, byDay.get(d.captured_on) ?? []),
    })),
  }
}
