// Layer 3 — transcribeInstagramVideos (§18): speech-to-text for Instagram video posts that don't have
// a transcript yet, via AssemblyAI. Runs as a follow-on after an Instagram scrape (like enrich) and can
// be triggered on demand via /api/transcribe. Bounded by `limit`; call repeatedly to drain.
// Fully non-fatal — a missing key or a per-clip failure logs and returns without throwing.
//
// AssemblyAI downloads the audio itself, so it needs the post's DIRECT media url to still be live.
// Instagram CDN urls are signed and expire within days, so this works on freshly-scraped posts and
// reports older ones as `unavailable` rather than pretending they had no speech (§18.1).

import { AudioUnavailableError, transcribeAudio } from '@/lib/assemblyai'
import {
  countVideoPostsMissingTranscript,
  getVideoPostsMissingTranscript,
  setTranscript,
} from '@/lib/db/posts.repo'
import { isPostMedia } from '@/lib/pure/media'
import { getKey } from '@/lib/settings'

export interface TranscribeResult {
  transcribed: number
  remaining: number
  /** Clips whose media url had expired — they stay NULL and need a re-scrape, not a retry. */
  unavailable: number
}

// Clips are submitted one at a time: a reel is seconds of audio, the batch is already bounded by
// `limit`, and a serial loop stays well inside AssemblyAI's concurrency limits without a queue.
/** The direct media url stored on the post, or null when it isn't a video we can fetch. */
function mediaUrl(media: string | null): string | null {
  if (!media) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(media)
  } catch {
    return null // a corrupt media value must not take down the batch
  }
  if (!isPostMedia(parsed) || parsed.type !== 'video') return null
  return parsed.url
}

export async function transcribeInstagramVideos(limit: number): Promise<TranscribeResult> {
  const posts = getVideoPostsMissingTranscript(limit)
  const done = (transcribed: number, unavailable: number): TranscribeResult => ({
    transcribed,
    unavailable,
    remaining: countVideoPostsMissingTranscript(),
  })
  if (posts.length === 0) return done(0, 0)

  if (!getKey('assemblyai_api_key')) {
    console.warn('transcribe: no AssemblyAI key set — skipping')
    return done(0, 0)
  }

  let transcribed = 0
  let unavailable = 0
  for (const p of posts) {
    const url = mediaUrl(p.media)
    if (!url) {
      console.warn(`transcribe: ${p.id} has no usable video url — skipping`)
      continue
    }
    try {
      const { text } = await transcribeAudio(url)
      if (text && text.trim()) {
        setTranscript(p.id, text.trim())
        transcribed++
      } else {
        // Transcribed fine but produced nothing → no speech (music-only reel). Store '' (not NULL)
        // so it leaves the missing-transcript queue and is never re-attempted, and the card shows
        // no transcript block. A post we could NOT attempt stays NULL and is retried.
        setTranscript(p.id, '')
      }
    } catch (err) {
      if (err instanceof AudioUnavailableError) {
        // Expired CDN signature. Leave NULL: the fix is re-scraping that post for a fresh url, and
        // marking it '' here would silently drop it from the queue forever.
        unavailable++
        console.warn(`transcribe: media url expired for ${p.id} — re-scrape it to transcribe`)
      } else {
        console.error(`transcribe: failed for ${p.id}:`, (err as Error).message)
      }
    }
  }

  if (unavailable > 0) {
    console.warn(
      `transcribe: ${unavailable} clip(s) had expired media urls. Re-scrape those Instagram posts, ` +
        'then transcribe again — AssemblyAI fetches the audio itself and Instagram signs its urls.',
    )
  }
  return done(transcribed, unavailable)
}
