// Layer 2 — AssemblyAI adapter (§18). All HTTP mocked with msw; never hits the real API.
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AudioUnavailableError, transcribeAudio } from '@/lib/assemblyai'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import { server } from '@/tests/msw/server'

const SUBMIT = 'https://api.assemblyai.com/v2/transcript'
const POLL = 'https://api.assemblyai.com/v2/transcript/t1'

beforeEach(() => {
  getDb(':memory:')
  setSettings({ assemblyai_api_key: 'ak' })
})
afterEach(() => resetDb())

const completed = (over = {}) => ({
  id: 't1',
  status: 'completed',
  text: 'hello world',
  audio_duration: 42,
  sentiment_analysis_results: null,
  ...over,
})

describe('transcribeAudio', () => {
  it('submits the url and returns the completed transcript', async () => {
    server.use(
      http.post(SUBMIT, () => HttpResponse.json({ id: 't1' })),
      http.get(POLL, () => HttpResponse.json(completed())),
    )
    const result = await transcribeAudio('https://cdn/clip.mp4')
    expect(result.text).toBe('hello world')
    expect(result.audio_duration).toBe(42)
  })

  it('authorizes with the BYO key and posts the audio_url', async () => {
    let auth: string | null = null
    let body: { audio_url?: string; sentiment_analysis?: boolean } | null = null
    server.use(
      http.post(SUBMIT, async ({ request }) => {
        auth = request.headers.get('authorization')
        body = (await request.json()) as typeof body
        return HttpResponse.json({ id: 't1' })
      }),
      http.get(POLL, () => HttpResponse.json(completed())),
    )
    await transcribeAudio('https://cdn/clip.mp4')
    expect(auth).toBe('ak')
    expect(body).toEqual({ audio_url: 'https://cdn/clip.mp4' })
  })

  it('omits the priced sentiment add-on unless asked', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post(SUBMIT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: 't1' })
      }),
      http.get(POLL, () => HttpResponse.json(completed())),
    )
    await transcribeAudio('https://cdn/clip.mp4', { sentiment: true })
    expect(body!.sentiment_analysis).toBe(true)
  })

  it('throws a clear error when the key is unset — never a silent skip', async () => {
    setSettings({ assemblyai_api_key: '' })
    await expect(transcribeAudio('https://cdn/clip.mp4')).rejects.toThrow(/AssemblyAI API key is not set/)
  })

  it('polls until the transcript leaves the queue', async () => {
    let polls = 0
    server.use(
      http.post(SUBMIT, () => HttpResponse.json({ id: 't1' })),
      http.get(POLL, () => {
        polls += 1
        return HttpResponse.json(polls < 2 ? { ...completed(), status: 'processing', text: null } : completed())
      }),
    )
    expect((await transcribeAudio('https://cdn/clip.mp4')).text).toBe('hello world')
    expect(polls).toBe(2)
  })

  it('raises AudioUnavailableError when the media url cannot be downloaded', async () => {
    server.use(
      http.post(SUBMIT, () => HttpResponse.json({ id: 't1' })),
      http.get(POLL, () =>
        HttpResponse.json({ ...completed(), status: 'error', text: null, error: 'Download error, 403 Forbidden' }),
      ),
    )
    await expect(transcribeAudio('https://cdn/expired.mp4')).rejects.toBeInstanceOf(AudioUnavailableError)
  })

  it('raises a plain error for a genuine transcription failure', async () => {
    server.use(
      http.post(SUBMIT, () => HttpResponse.json({ id: 't1' })),
      http.get(POLL, () =>
        HttpResponse.json({ ...completed(), status: 'error', text: null, error: 'Audio too short to process' }),
      ),
    )
    const err = await transcribeAudio('https://cdn/clip.mp4').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AudioUnavailableError)
  })

  it('surfaces a non-2xx submit as an error', async () => {
    server.use(http.post(SUBMIT, () => new HttpResponse(null, { status: 401 })))
    await expect(transcribeAudio('https://cdn/clip.mp4')).rejects.toThrow(/submit failed \(401\)/)
  })
})
