// Layer 2 — AssemblyAI adapter (§18). Same shape as lib/apify.ts: reads the key from settings (BYO),
// never process.env, throws a clear error when unset, never logs the key.
//
// This is the production speech-to-text path for Instagram video posts. It takes a DIRECT media url
// and hands it to AssemblyAI, which downloads the audio itself — so the url must still be live. See
// jobs/transcribe.ts for how an expired Instagram CDN url is handled.

import { fetchWithTimeout } from '@/lib/http'
import { getKey } from '@/lib/settings'

const BASE = 'https://api.assemblyai.com/v2'
const POLL_INTERVAL_MS = 2000
const MAX_POLLS = 300 // 300 * 2s = 10 min per clip; a reel is seconds of audio, so this is generous
const SUBMIT_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000

export interface TranscriptResult {
  id: string
  status: 'queued' | 'processing' | 'completed' | 'error'
  text: string | null
  audio_duration: number | null
  sentiment_analysis_results: { text: string; sentiment: string; confidence: number }[] | null
  error?: string
}

/**
 * AssemblyAI could not fetch the media url (expired signature, 403/404). Distinct from a transcription
 * failure because the fix is different: re-scrape the post for a fresh url, don't retry this one.
 */
export class AudioUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioUnavailableError'
  }
}

function requireKey(): string {
  const key = getKey('assemblyai_api_key')
  if (!key) {
    throw new Error('AssemblyAI API key is not set — add it in Settings before transcribing.')
  }
  return key
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** AssemblyAI reports a failed media download in the transcript's own `error` string. */
const isDownloadFailure = (error: string | undefined): boolean =>
  /download|fetch|not (?:be )?(?:accessible|found)|403|404|url/i.test(error ?? '')

/**
 * Submit one media url, poll to completion, return the finished transcript.
 * `sentiment` is opt-in — it is a priced add-on and the posts table stores only the text.
 */
export async function transcribeAudio(
  audioUrl: string,
  opts?: { sentiment?: boolean },
): Promise<TranscriptResult> {
  const key = requireKey()

  const submitRes = await fetchWithTimeout(
    `${BASE}/transcript`,
    {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, ...(opts?.sentiment && { sentiment_analysis: true }) }),
    },
    SUBMIT_TIMEOUT_MS,
  )
  if (!submitRes.ok) throw new Error(`AssemblyAI: submit failed (${submitRes.status})`)
  const { id } = (await submitRes.json()) as { id: string }

  for (let i = 0; i < MAX_POLLS; i++) {
    const pollRes = await fetchWithTimeout(
      `${BASE}/transcript/${id}`,
      { headers: { authorization: key } },
      POLL_TIMEOUT_MS,
    )
    if (!pollRes.ok) throw new Error(`AssemblyAI: poll failed (${pollRes.status})`)
    const json = (await pollRes.json()) as TranscriptResult
    if (json.status === 'completed') return json
    if (json.status === 'error') {
      if (isDownloadFailure(json.error)) throw new AudioUnavailableError(`AssemblyAI: ${json.error}`)
      throw new Error(`AssemblyAI: transcription error: ${json.error}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('AssemblyAI: timed out waiting for transcript')
}
