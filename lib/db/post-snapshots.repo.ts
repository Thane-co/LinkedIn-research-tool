// Layer 2 — post engagement snapshot store (PRD §6.8, §22). Storage only; the growth math lives in
// lib/pure/post-growth.ts.
//
// One row per post per UTC day. The (post_id, captured_on) primary key makes the rolling re-scrape
// re-runnable: capturing twice in a day refreshes that day instead of appending a duplicate that
// would read as a zero-gain step.

import { getDb } from '@/lib/db/db'
import type { PostSnapshot } from '@/lib/pure/post-growth'

export interface NewPostSnapshot {
  post_id: string
  captured_on: string
  captured_at: string
  likes: number
  comments: number
  shares: number
}

const INSERT = `INSERT INTO post_snapshots (post_id, captured_on, captured_at, likes, comments, shares)
   VALUES (@post_id, @captured_on, @captured_at, @likes, @comments, @shares)
   ON CONFLICT(post_id, captured_on) DO UPDATE SET
     captured_at = excluded.captured_at,
     likes       = excluded.likes,
     comments    = excluded.comments,
     shares      = excluded.shares`

/** Record a batch of captures in one transaction. Returns the number written. */
export function recordPostSnapshots(rows: NewPostSnapshot[]): number {
  if (rows.length === 0) return 0
  const stmt = getDb().prepare(INSERT)
  getDb().transaction((batch: NewPostSnapshot[]) => {
    for (const r of batch) stmt.run(r)
  })(rows)
  return rows.length
}

/** One post's series, oldest first — the shape lib/pure/post-growth.ts consumes. */
export function getPostSnapshots(postId: string): PostSnapshot[] {
  return getDb()
    .prepare(
      `SELECT captured_on, captured_at, likes, comments, shares FROM post_snapshots
       WHERE post_id = ? ORDER BY captured_at ASC`,
    )
    .all(postId) as PostSnapshot[]
}

/** Series for many posts in ONE query, keyed by post id. Posts with no snapshots are absent. */
export function getPostSnapshotsFor(postIds: string[]): Map<string, PostSnapshot[]> {
  const out = new Map<string, PostSnapshot[]>()
  if (postIds.length === 0) return out

  const rows = getDb()
    .prepare(
      `SELECT post_id, captured_on, captured_at, likes, comments, shares FROM post_snapshots
       WHERE post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY captured_at ASC`,
    )
    .all(...postIds) as (PostSnapshot & { post_id: string })[]

  for (const { post_id, ...snap } of rows) {
    const series = out.get(post_id)
    if (series) series.push(snap)
    else out.set(post_id, [snap])
  }
  return out
}

/** Total rows stored. */
export function countPostSnapshots(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM post_snapshots`).get() as { n: number }).n
}
