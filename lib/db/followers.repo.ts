// Layer 2 — follower snapshot store (PRD §6.7, §21). Storage only; all growth math lives in
// lib/pure/follower-growth.ts.
//
// A snapshot is one creator's follower count on one UTC day. The (author_id, platform, captured_on)
// primary key makes the daily job re-runnable: capturing twice in a day refreshes the row instead of
// appending a duplicate that would read as a zero-gain day.

import { getDb } from '@/lib/db/db'
import type { Snapshot } from '@/lib/pure/follower-growth'
import type { Platform } from '@/lib/types'

export interface NewSnapshot {
  author_id: string
  platform: Platform
  captured_on: string
  captured_at: string
  followers: number
  connections?: number | null
  source: 'profile-actor' | 'post-author' | 'seed'
}

const VALUES = `INSERT INTO follower_snapshots (author_id, platform, captured_on, captured_at, followers, connections, source)
   VALUES (@author_id, @platform, @captured_on, @captured_at, @followers, @connections, @source)`

/** A capture wins its day: re-running the job refreshes the row rather than duplicating it. */
const INSERT = `${VALUES}
   ON CONFLICT(author_id, platform, captured_on) DO UPDATE SET
     captured_at = excluded.captured_at,
     followers   = excluded.followers,
     connections = excluded.connections,
     source      = excluded.source`

/** A seed never overwrites a real capture, so it yields its day rather than claiming it. */
const SEED_INSERT = `${VALUES} ON CONFLICT(author_id, platform, captured_on) DO NOTHING`

const bind = (s: NewSnapshot): Record<string, unknown> => ({ ...s, connections: s.connections ?? null })

/** Record one capture. Re-capturing the same day refreshes that day's row. */
export function recordSnapshot(s: NewSnapshot): void {
  getDb().prepare(INSERT).run(bind(s))
}

/** Record a whole day's captures in one transaction. Returns the number written. */
export function recordSnapshots(rows: NewSnapshot[]): number {
  if (rows.length === 0) return 0
  const stmt = getDb().prepare(INSERT)
  const tx = getDb().transaction((batch: NewSnapshot[]) => {
    for (const r of batch) stmt.run(bind(r))
  })
  tx(rows)
  return rows.length
}

/** One creator's series, oldest first — the shape lib/pure/follower-growth.ts consumes. */
export function getSnapshots(authorId: string, platform: Platform): Snapshot[] {
  return getDb()
    .prepare(
      `SELECT captured_on, captured_at, followers FROM follower_snapshots
       WHERE author_id = ? AND platform = ? ORDER BY captured_at ASC`,
    )
    .all(authorId, platform) as Snapshot[]
}

/** Every series for a platform since a day key, grouped by author_id. One query, not N. */
export function getSnapshotsSince(platform: Platform, sinceDay: string): Map<string, Snapshot[]> {
  const rows = getDb()
    .prepare(
      `SELECT author_id, captured_on, captured_at, followers FROM follower_snapshots
       WHERE platform = ? AND captured_on >= ? ORDER BY captured_at ASC`,
    )
    .all(platform, sinceDay) as (Snapshot & { author_id: string })[]

  const out = new Map<string, Snapshot[]>()
  for (const { author_id, ...snap } of rows) {
    const series = out.get(author_id)
    if (series) series.push(snap)
    else out.set(author_id, [snap])
  }
  return out
}

/** The newest day captured for a platform, or null before the first capture. */
export function latestSnapshotDay(platform: Platform): string | null {
  const row = getDb()
    .prepare(`SELECT MAX(captured_on) AS day FROM follower_snapshots WHERE platform = ?`)
    .get(platform) as { day: string | null } | undefined
  return row?.day ?? null
}

/** Total rows stored (all platforms). */
export function countSnapshots(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM follower_snapshots`).get() as { n: number }).n
}

/**
 * Backfill the series' first data point from profiles already scraped (§6.6), so the leaderboard has
 * a baseline on day one instead of waiting 24h for its first delta.
 *
 * `DO NOTHING` on conflict, not `DO UPDATE`: a real capture always outranks a seed. A profile with
 * `followers = 0` is skipped — that is a scrape that returned nothing, and storing it as a
 * measurement would invent a spike on the next real capture.
 */
export function seedSnapshotsFromProfiles(): number {
  const rows = getDb()
    .prepare(`SELECT id, followers, connections, scraped_at FROM profiles WHERE followers > 0`)
    .all() as { id: string; followers: number; connections: number; scraped_at: string }[]

  const stmt = getDb().prepare(SEED_INSERT)
  const tx = getDb().transaction((batch: typeof rows) => {
    let n = 0
    for (const r of batch) {
      const res = stmt.run({
        author_id: r.id,
        platform: 'linkedin',
        captured_on: r.scraped_at.slice(0, 10),
        captured_at: r.scraped_at,
        followers: r.followers,
        connections: r.connections ?? null,
        source: 'seed',
      })
      n += res.changes
    }
    return n
  })
  return tx(rows) as number
}
