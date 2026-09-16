// Layer 4 — POST /api/transcribe (§18). Thin: backfill transcripts for Instagram video posts missing
// one, via AssemblyAI. 412 with { needs } when the AssemblyAI key is unset. Bounded by an optional
// `limit` (default 25) so one batch stays bounded — call again to drain the rest.

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
  if (!getKey('assemblyai_api_key')) return NextResponse.json({ needs: ['assemblyai_api_key'] }, { status: 412 })

  const body = (await req.json().catch(() => ({}))) as { limit?: number }
  const limit = body.limit && body.limit > 0 ? body.limit : DEFAULT_LIMIT

  const result = await transcribeInstagramVideos(limit)
  return NextResponse.json(result)
}
