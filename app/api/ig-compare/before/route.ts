// Temporary tab: transcribe the given posts via the real production actor
// (crawlerbros/instagram-transcript-scraper) — one batched run, nothing lands until it finishes.
import { NextResponse } from 'next/server'
import { buildInstagramTranscriptInput, runActor } from '@/lib/apify'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { SETTINGS_DEFAULTS } from '@/lib/config'
import { beforeTranscriptionCost } from '@/lib/ig-compare/pricing'
import type { ClipResult, DiscoveredPost, ResearchResponse } from '@/lib/ig-compare/types'
import { extractInstagramShortcode } from '@/lib/pure/url'
import { getSettings } from '@/lib/settings'
import type { ApifyInstagramTranscript } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked

  const { posts } = (await req.json().catch(() => ({}))) as { posts?: DiscoveredPost[] }
  if (!posts || posts.length === 0) return NextResponse.json({ error: 'posts is required' }, { status: 400 })

  const start = Date.now()
  const actorId = getSettings().apify_instagram_transcript_actor_id ?? SETTINGS_DEFAULTS.apify_instagram_transcript_actor_id

  let transcripts: ApifyInstagramTranscript[]
  try {
    // The actor wants the Instagram post/reel PAGE url (postUrl), not the raw CDN video file url —
    // matches jobs/transcribe.ts, the real production pipeline.
    transcripts = (await runActor(
      actorId,
      buildInstagramTranscriptInput(posts.map((p) => p.postUrl)),
    )) as ApifyInstagramTranscript[]
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }

  // Match by shortCode AND postUrl (whichever the actor's result carries), same as
  // jobs/transcribe.ts — the actor doesn't always echo back the exact input url string.
  const byCode = new Map<string, string>()
  const byUrl = new Map<string, string>()
  for (const t of transcripts) {
    const text = (t.fullText ?? '').trim()
    if (t.shortCode) byCode.set(t.shortCode, text)
    if (t.postUrl) byUrl.set(t.postUrl, text)
  }

  const clips: ClipResult[] = posts.map((p) => {
    const code = extractInstagramShortcode(p.postUrl) ?? p.shortCode
    const transcript = (code ? byCode.get(code) : undefined) ?? byUrl.get(p.postUrl) ?? ''
    return {
      shortCode: p.shortCode,
      postUrl: p.postUrl,
      thumbnail: p.thumbnail,
      caption: p.caption,
      transcript,
    }
  })

  const body: ResearchResponse = {
    method: 'apify-whisper',
    postCount: posts.length,
    elapsedMs: Date.now() - start,
    estimatedCostUsd: beforeTranscriptionCost(posts.length),
    clips,
  }
  return NextResponse.json(body)
}
