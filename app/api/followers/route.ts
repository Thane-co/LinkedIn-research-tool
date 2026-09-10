// Layer 4 — /api/followers (§21). Thin: parse + delegate to buildLeaderboard(). Both champion boards
// (absolute gain, percentage gain) for one window, with every core LinkedIn creator on the absolute
// one. Read-only, so no CSRF guard is needed — but `force-dynamic` is, or the App Router would
// prerender the handler and freeze the board at build time.

import { NextResponse } from 'next/server'
import { buildLeaderboard } from '@/lib/followers-query'

export const dynamic = 'force-dynamic'

/** The windows the UI offers. An unbounded window would scan the whole series for every creator. */
const ALLOWED_WINDOWS = [1, 7, 30] as const
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams

  const raw = params.get('window')
  const windowDays = raw === null ? 1 : Number(raw)
  if (!ALLOWED_WINDOWS.includes(windowDays as (typeof ALLOWED_WINDOWS)[number])) {
    return NextResponse.json({ error: `window must be one of ${ALLOWED_WINDOWS.join(', ')}` }, { status: 400 })
  }

  // A malformed asOf is rejected rather than defaulted: silently swapping in today's date would
  // answer a different question than the one asked, and the caller could not tell.
  const asOf = params.get('asOf')
  if (asOf !== null && !DAY_KEY.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be a YYYY-MM-DD day key' }, { status: 400 })
  }

  return NextResponse.json(buildLeaderboard({ windowDays, ...(asOf ? { asOf } : {}) }))
}
