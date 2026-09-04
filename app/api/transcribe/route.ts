// Layer 4 — POST /api/transcribe (§18). Thin: backfill transcripts for Instagram video posts missing
// one. 412 with { needs } when the Apify token is unset. Bounded by an optional `limit` (default 25)
// so a single actor run stays within the poll ceiling — call again to drain the rest.

import { NextResponse } from 'next/server'
import { transcribeInstagramVideos } from '@/jobs/transcribe'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { getKey } from '@/lib/settings'

// Writes transcripts to the live DB — never prerender/cache.
export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 25

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  if (!getKey('apify_api_token')) return NextResponse.json({ needs: ['apify_api_token'] }, { status: 412 })

  const body = (await req.json().catch(() => ({}))) as { limit?: number }
  const limit = body.limit && body.limit > 0 ? body.limit : DEFAULT_LIMIT

  const result = await transcribeInstagramVideos(limit)
  return NextResponse.json(result)
}
