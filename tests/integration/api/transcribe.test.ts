import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/transcribe/route'
import { transcribeInstagramVideos } from '@/jobs/transcribe'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'

vi.mock('@/jobs/transcribe', () => ({ transcribeInstagramVideos: vi.fn() }))
const mockJob = vi.mocked(transcribeInstagramVideos)

const post = (body: unknown): Request =>
  new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
})
afterEach(() => resetDb())

describe('POST /api/transcribe (§18)', () => {
  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    const req = new Request('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { origin: 'http://evil.com', 'content-type': 'application/json' },
      body: '{}',
    })
    expect((await POST(req)).status).toBe(403)
  })

  it('412s with the missing key when the AssemblyAI key is unset', async () => {
    const res = await POST(post({}))
    expect(res.status).toBe(412)
    expect((await res.json()).needs).toContain('assemblyai_api_key')
  })

  it('does NOT gate on the Apify token — transcription no longer runs an actor', async () => {
    setSettings({ apify_api_token: 'tok' })
    expect((await POST(post({}))).status).toBe(412)
  })

  it('runs the transcribe job and returns its result', async () => {
    setSettings({ assemblyai_api_key: 'ak' })
    mockJob.mockResolvedValue({ transcribed: 3, remaining: 5, unavailable: 1 })
    const res = await POST(post({ limit: 10 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ transcribed: 3, remaining: 5, unavailable: 1 })
    expect(mockJob).toHaveBeenCalledWith(10)
  })

  it('defaults the limit when none is supplied', async () => {
    setSettings({ assemblyai_api_key: 'ak' })
    mockJob.mockResolvedValue({ transcribed: 0, remaining: 0, unavailable: 0 })
    await POST(post({}))
    expect(mockJob).toHaveBeenCalledWith(expect.any(Number))
    expect(mockJob.mock.calls[0]![0]).toBeGreaterThan(0)
  })
})
