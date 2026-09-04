// Layer 3 — transcribeInstagramVideos (§18): backfill speech-to-text transcripts for Instagram video
// posts that don't have one yet. Runs as a follow-on after an Instagram scrape (like enrich) and can
// be triggered on demand via /api/transcribe. Bounded by `limit` so one actor run stays within the
// poll ceiling; call repeatedly to drain. Fully non-fatal — a missing actor id/token or an actor
// failure logs and returns { transcribed: 0 } without throwing.

import { buildInstagramTranscriptInput, runActor } from '@/lib/apify'
import {
  countVideoPostsMissingTranscript,
  getVideoPostsMissingTranscript,
  setTranscript,
} from '@/lib/db/posts.repo'
import { extractInstagramShortcode } from '@/lib/pure/url'
import { getKey, getSettings } from '@/lib/settings'
import type { ApifyInstagramTranscript } from '@/lib/types'

export interface TranscribeResult {
  transcribed: number
  remaining: number
}

// Transcription (esp. Whisper fallback) is far slower than a scrape — a batch can take well over the
// default ~10-min ceiling. Poll up to ~40 min so we don't abandon (and still pay for) a running job.
const TRANSCRIBE_MAX_POLLS = 1600 // 1600 * 1.5s ≈ 40 min

export async function transcribeInstagramVideos(limit: number): Promise<TranscribeResult> {
  const posts = getVideoPostsMissingTranscript(limit)
  if (posts.length === 0) return { transcribed: 0, remaining: countVideoPostsMissingTranscript() }

  const actorId = getSettings().apify_instagram_transcript_actor_id
  if (!actorId || !getKey('apify_api_token')) {
    console.warn('transcribe: no transcript actor id or Apify token set — skipping')
    return { transcribed: 0, remaining: countVideoPostsMissingTranscript() }
  }

  const urls = posts.map((p) => p.url).filter((u): u is string => !!u)
  let results: ApifyInstagramTranscript[]
  try {
    results = (await runActor(actorId, buildInstagramTranscriptInput(urls), {
      maxPolls: TRANSCRIBE_MAX_POLLS,
    })) as ApifyInstagramTranscript[]
  } catch (err) {
    console.error('transcribe: actor failed:', (err as Error).message)
    return { transcribed: 0, remaining: countVideoPostsMissingTranscript() }
  }

  // Index results by shortCode AND canonical url so we match whichever key the post carries. A result
  // the actor RETURNED but with empty text = a video with no transcribable speech (music-only reel);
  // track those separately so we can mark them "no speech" instead of re-attempting them forever.
  const byCode = new Map<string, string>()
  const byUrl = new Map<string, string>()
  const emptyCodes = new Set<string>()
  const emptyUrls = new Set<string>()
  for (const r of results) {
    const text = (r.fullText ?? '').trim()
    if (text) {
      if (r.shortCode) byCode.set(r.shortCode, text)
      if (r.postUrl) byUrl.set(r.postUrl, text)
    } else {
      if (r.shortCode) emptyCodes.add(r.shortCode)
      if (r.postUrl) emptyUrls.add(r.postUrl)
    }
  }

  let transcribed = 0
  for (const p of posts) {
    const code = extractInstagramShortcode(p.url)
    const text = (code ? byCode.get(code) : undefined) ?? (p.url ? byUrl.get(p.url) : undefined)
    try {
      if (text) {
        setTranscript(p.id, text)
        transcribed++
      } else if ((code && emptyCodes.has(code)) || (p.url && emptyUrls.has(p.url))) {
        // Actor processed it but produced no text → no transcribable speech. Store '' (not NULL) so
        // it's excluded from getVideoPostsMissingTranscript and never re-attempted. The card shows no
        // transcript block for an empty string. A post the actor didn't return stays NULL → retried.
        setTranscript(p.id, '')
      }
    } catch (err) {
      console.error(`transcribe: failed to store transcript for ${p.id}:`, (err as Error).message)
    }
  }
  return { transcribed, remaining: countVideoPostsMissingTranscript() }
}
