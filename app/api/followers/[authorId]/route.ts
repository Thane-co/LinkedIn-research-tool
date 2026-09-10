// Layer 4 — /api/followers/[authorId] (§21). One creator's follower series plus per-day deltas with
// their posts attached — the sparkline and the "+412 followers that day" badge.

import { NextResponse } from 'next/server'
import { creatorGrowthDetail } from '@/lib/followers-query'

export const dynamic = 'force-dynamic'

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 365

export async function GET(
  req: Request,
  { params }: { params: { authorId: string } },
): Promise<NextResponse> {
  const search = new URL(req.url).searchParams

  const rawDays = search.get('days')
  const days = rawDays === null ? 30 : Number(rawDays)
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return NextResponse.json({ error: `days must be an integer between 1 and ${MAX_DAYS}` }, { status: 400 })
  }

  const asOf = search.get('asOf')
  if (asOf !== null && !DAY_KEY.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be a YYYY-MM-DD day key' }, { status: 400 })
  }

  // An unknown creator is an empty series, not a 404: the UI asks for a creator it already listed,
  // and "we have not captured them yet" is a legitimate, renderable answer.
  return NextResponse.json(creatorGrowthDetail(params.authorId, { days, ...(asOf ? { asOf } : {}) }))
}
