// Temporary tab: minimal AssemblyAI adapter, same shape as lib/apify.ts — reads the key from
// settings (BYO), never process.env, throws a clear error when unset, never logs the key.

import { fetchWithTimeout } from '@/lib/http'
import { getKey } from '@/lib/settings'

const BASE = 'https://api.assemblyai.com/v2'
const POLL_INTERVAL_MS = 2000
const MAX_POLLS = 300
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

function requireKey(): string {
  const key = getKey('assemblyai_api_key')
  if (!key) {
    throw new Error('AssemblyAI API key is not set — add it in Settings before running this comparison.')
  }
  return key
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Submit one clip to AssemblyAI with sentiment analysis on, poll to completion, return the result. */
export async function transcribeWithSentiment(audioUrl: string): Promise<TranscriptResult> {
  const key = requireKey()

  const submitRes = await fetchWithTimeout(
    `${BASE}/transcript`,
    {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, sentiment_analysis: true }),
    },
    SUBMIT_TIMEOUT_MS,
  )
  if (!submitRes.ok) throw new Error(`AssemblyAI: submit failed (${submitRes.status})`)
  const { id } = (await submitRes.json()) as { id: string }

  for (let i = 0; i < MAX_POLLS; i++) {
    const pollRes = await fetchWithTimeout(`${BASE}/transcript/${id}`, { headers: { authorization: key } }, POLL_TIMEOUT_MS)
    if (!pollRes.ok) throw new Error(`AssemblyAI: poll failed (${pollRes.status})`)
    const json = (await pollRes.json()) as TranscriptResult
    if (json.status === 'completed') return json
    if (json.status === 'error') throw new Error(`AssemblyAI: transcription error: ${json.error}`)
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('AssemblyAI: timed out waiting for transcript')
}
