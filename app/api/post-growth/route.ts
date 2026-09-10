// Layer 4 — GET /api/post-growth (§22). Thin. Recent posts with their engagement curves; pass
// `authorId` to scope to one creator and get their own median day-1 yardstick alongside.

import { NextResponse } from 'next/server'
import { creatorPostGrowth, recentPostGrowth } from '@/lib/post-growth-query'

export const dynamic = 'force-dynamic'

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 365

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams

  const rawDays = sp.get('days')
  const days = rawDays === null ? 7 : Number(rawDays)
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return NextResponse.json({ error: `days must be an integer between 1 and ${MAX_DAYS}` }, { status: 400 })
  }

  const asOf = sp.get('asOf')
  if (asOf !== null && !DAY_KEY.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be a YYYY-MM-DD day key' }, { status: 400 })
  }
  const window = { days, ...(asOf ? { asOf } : {}) }

  const authorId = sp.get('authorId')
  if (authorId) {
    return NextResponse.json({ days, ...creatorPostGrowth(authorId, window) })
  }
  return NextResponse.json({ days, posts: recentPostGrowth(window) })
}
