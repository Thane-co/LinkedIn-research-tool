// Layer 4 — POST /api/followers/snapshot (§21). Captures today's follower count for the whole core
// LinkedIn roster on demand (the daily launchd job calls the same job function directly). Mutating,
// so it takes the CSRF guard and the Apify token gate, exactly like /api/profile.

import { NextResponse } from 'next/server'
import { snapshotFollowers } from '@/jobs/snapshot-followers'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { getKey } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  if (!getKey('apify_api_token')) return NextResponse.json({ needs: ['apify_api_token'] }, { status: 412 })

  try {
    return NextResponse.json(await snapshotFollowers())
  } catch (err) {
    // Only a hard misconfiguration reaches here — a failed BATCH is reported inside the result.
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
