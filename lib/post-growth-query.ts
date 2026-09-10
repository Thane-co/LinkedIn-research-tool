// Layer 3 — the one post-growth implementation (PRD §22), composed from the snapshot store and the
// pure growth math. Shared by the dashboard route and (later) the agent API, the same way
// runPostsQuery() and buildLeaderboard() are shared.

import { getDb } from '@/lib/db/db'
import { getPostSnapshotsFor } from '@/lib/db/post-snapshots.repo'
import { engagementDeltas, summarizePostGrowth, type PostSnapshot } from '@/lib/pure/post-growth'

const DAY_MS = 24 * 60 * 60 * 1000

const dayKeyBefore = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - n * DAY_MS).toISOString().slice(0, 10)

export interface PostGrowthRow {
  id: string
  author_id: string
  author_name: string | null
  url: string | null
  content: string | null
  posted_at: string | null
  x_factor: number | null
  /** Total engagement now (likes + comments + shares) from the live `posts` row. */
  current_total: number
  day1: number | null
  day2: number | null
  day3: number | null
  /** Engagement added in the most recent measured step — "what moved since yesterday". */
  gained_today: number | null
  still_climbing: boolean
  pct_after_day1: number | null
}

interface PostRecord {
  id: string
  author_id: string
  author_name: string | null
  url: string | null
  content: string | null
  posted_at: string | null
  x_factor: number | null
  current_total: number
}

/** Posts by roster creators inside the window. Roster-only: nothing else is being re-measured. */
function rosterPostsInWindow(fromDay: string, toDay: string): PostRecord[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.author_id, p.author_name, p.url, p.content, p.posted_at, p.x_factor,
              (p.likes + p.comments + p.shares) AS current_total
       FROM posts p
       JOIN creators c ON c.author_id = p.author_id AND c.platform = 'linkedin'
       WHERE p.platform = 'linkedin' AND p.posted_at >= ? AND p.posted_at <= ?
       ORDER BY p.posted_at DESC`,
    )
    .all(`${fromDay}T00:00:00.000Z`, `${toDay}T23:59:59.999Z`) as PostRecord[]
}

function toRow(p: PostRecord, series: PostSnapshot[]): PostGrowthRow {
  const summary = summarizePostGrowth(p.posted_at ?? '', series)
  const deltas = engagementDeltas(series)
  return {
    ...p,
    day1: summary.day1,
    day2: summary.day2,
    day3: summary.day3,
    // null, not 0: a post measured once has no step yet, which is not the same as a flat one.
    gained_today: deltas.length > 0 ? deltas[deltas.length - 1]!.gained : null,
    still_climbing: summary.still_climbing,
    pct_after_day1: summary.pct_after_day1,
  }
}

/**
 * Every roster post published in the last `days`, with its growth curve. Sorted by what gained most
 * in the latest step, so the top of the list is "what is moving right now" rather than "what was
 * biggest ever" — a post that peaked last week is not news.
 */
export function recentPostGrowth({ days = 7, asOf }: { days?: number; asOf?: string } = {}): PostGrowthRow[] {
  const day = asOf ?? new Date().toISOString().slice(0, 10)
  const posts = rosterPostsInWindow(dayKeyBefore(day, days), day)
  if (posts.length === 0) return []

  const series = getPostSnapshotsFor(posts.map((p) => p.id))
  return posts
    .map((p) => toRow(p, series.get(p.id) ?? []))
    .sort((a, b) => (b.gained_today ?? -Infinity) - (a.gained_today ?? -Infinity))
}

/** Middle value of a sorted numeric list; null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export interface CreatorPostGrowth {
  author_id: string
  posts: PostGrowthRow[]
  /** The creator's own median day-1 engagement — the yardstick a new post is judged against. */
  median_day1: number | null
}

/**
 * One creator's recent posts side by side, plus their own median day-1 number.
 *
 * The median is the point of the whole view: "412 likes" means nothing until you know this creator
 * normally does 90 by day one. It is deliberately the creator's OWN baseline, the same principle the
 * x-factor rests on (§8) — comparing a 6k-follower account's post to a 200k account's is noise.
 */
export function creatorPostGrowth(
  authorId: string,
  { days = 30, asOf }: { days?: number; asOf?: string } = {},
): CreatorPostGrowth {
  const day = asOf ?? new Date().toISOString().slice(0, 10)
  const posts = rosterPostsInWindow(dayKeyBefore(day, days), day).filter((p) => p.author_id === authorId)
  const series = getPostSnapshotsFor(posts.map((p) => p.id))
  const rows = posts.map((p) => toRow(p, series.get(p.id) ?? []))

  return {
    author_id: authorId,
    posts: rows,
    median_day1: median(rows.map((r) => r.day1).filter((d): d is number => d !== null)),
  }
}
