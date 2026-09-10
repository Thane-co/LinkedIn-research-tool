// Layer 4 — PUT /api/creators/tracking (§21.8). Thin. Opts a creator (or many) into or out of the
// daily follower capture.
//
// This is the SECOND list, not a second roster: the creator stays in `creators` and keeps being
// scraped for content research either way. All this flag decides is whether they cost a daily
// profile call and appear on the champion leaderboard.

import { NextResponse } from 'next/server'
import { PROFILE_SCRAPE_COST_PER_PROFILE } from '@/lib/config'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { setCreatorTracking } from '@/lib/db/creators.repo'
import { getDb } from '@/lib/db/db'

export const dynamic = 'force-dynamic'

/**
 * The pick list: every LinkedIn creator with the numbers you would actually choose on — last known
 * follower count, how much they post, and their best recent x-factor — plus what the current
 * selection costs per month. Sorted by followers so the big accounts are easy to find.
 */
export async function GET(): Promise<NextResponse> {
  const creators = getDb()
    .prepare(
      `SELECT c.id, c.author_id, c.display_name, c.avatar_url, c.track_followers,
              (SELECT f.followers FROM follower_snapshots f
                WHERE f.author_id = c.author_id AND f.platform = 'linkedin'
                ORDER BY f.captured_at DESC LIMIT 1) AS followers,
              (SELECT COUNT(*) FROM posts p
                WHERE p.platform = 'linkedin' AND p.author_id = c.author_id
                  AND p.posted_at >= date('now', '-30 day')) AS posts_30d,
              (SELECT MAX(p.x_factor) FROM posts p
                WHERE p.platform = 'linkedin' AND p.author_id = c.author_id
                  AND p.posted_at >= date('now', '-90 day')) AS best_x_factor
       FROM creators c
       WHERE c.platform = 'linkedin'
       ORDER BY followers DESC NULLS LAST, c.display_name COLLATE NOCASE ASC`,
    )
    .all() as {
    id: string
    author_id: string | null
    display_name: string | null
    avatar_url: string | null
    track_followers: number
    followers: number | null
    posts_30d: number
    best_x_factor: number | null
  }[]

  const rows = creators.map(({ track_followers, ...c }) => ({ ...c, tracked: track_followers === 1 }))
  const trackedCount = rows.filter((r) => r.tracked).length

  return NextResponse.json({
    creators: rows,
    total: rows.length,
    tracked_count: trackedCount,
    monthly_cost: trackedCount * PROFILE_SCRAPE_COST_PER_PROFILE * 30,
  })
}

export async function PUT(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked

  const body = (await req.json()) as { id?: string; ids?: string[]; tracked?: unknown }
  if (typeof body.tracked !== 'boolean') {
    return NextResponse.json({ error: 'tracked must be a boolean' }, { status: 400 })
  }

  const ids = body.ids ?? (body.id ? [body.id] : [])
  if (ids.length === 0) {
    return NextResponse.json({ error: 'An id or a non-empty ids array is required' }, { status: 400 })
  }

  const updated = ids.map((id) => setCreatorTracking(id, body.tracked as boolean))
  const missing = ids.filter((_, i) => updated[i] === null)
  // A toggle that silently does nothing is worse than an error — say which ids did not exist.
  if (missing.length > 0) {
    return NextResponse.json({ error: `No such creator: ${missing.join(', ')}` }, { status: 404 })
  }

  const rows = updated.filter((r) => r !== null)
  return NextResponse.json({ updated: rows.length, creator: rows[0], creators: rows })
}
