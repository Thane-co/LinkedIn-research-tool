// Temporary tab: one direct AssemblyAI call per clip. Genuinely independent per clip (no forced
// batching), so the client fires one of these per discovered post and renders each as it lands.
import { NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { transcribeWithSentiment } from '@/lib/ig-compare/assemblyai'
import { afterTranscriptionCost } from '@/lib/ig-compare/pricing'
import type { ClipResult, DiscoveredPost } from '@/lib/ig-compare/types'

export const dynamic = 'force-dynamic'

export interface AfterClipResponse {
  elapsedMs: number
  estimatedCostUsd: number
  clip: ClipResult
}

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked

  const { post } = (await req.json().catch(() => ({}))) as { post?: DiscoveredPost }
  if (!post) return NextResponse.json({ error: 'post is required' }, { status: 400 })

  const start = Date.now()
  let r
  try {
    r = await transcribeWithSentiment(post.videoUrl)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }

  const clip: ClipResult = {
    shortCode: post.shortCode,
    postUrl: post.postUrl,
    thumbnail: post.thumbnail,
    caption: post.caption,
    transcript: r.text ?? '',
    sentiments: r.sentiment_analysis_results ?? [],
    audioDurationSec: r.audio_duration ?? undefined,
  }

  const body: AfterClipResponse = {
    elapsedMs: Date.now() - start,
    estimatedCostUsd: afterTranscriptionCost(r.audio_duration ?? 0),
    clip,
  }
  return NextResponse.json(body)
}
