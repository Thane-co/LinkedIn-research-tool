// Layer 4 — POST /api/post-growth/refresh (§22). Runs the rolling engagement re-scrape on demand;
// the daily launchd job calls the same function. Mutating AND billable, so it takes the CSRF guard
// and the Apify token gate, and returns the run's cost.

import { NextResponse } from 'next/server'
import { refreshRecentEngagement } from '@/jobs/refresh-engagement'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { getKey } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  if (!getKey('apify_api_token')) return NextResponse.json({ needs: ['apify_api_token'] }, { status: 412 })

  try {
    return NextResponse.json(await refreshRecentEngagement())
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
