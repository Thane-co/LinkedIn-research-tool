import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/scrape/route'
import { GET } from '@/app/api/scrape/[id]/route'
import { runScrape } from '@/jobs/scrape'
import { getDb, resetDb } from '@/lib/db/db'
import { createJob, getJob } from '@/lib/db/jobs.repo'
import { setSettings } from '@/lib/settings'

// The route fires runScrape without awaiting; mock it so no real actors run during the test.
vi.mock('@/jobs/scrape', () => ({ runScrape: vi.fn().mockResolvedValue(undefined) }))
const mockRunScrape = vi.mocked(runScrape)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  mockRunScrape.mockResolvedValue(undefined as never)
})
afterEach(() => resetDb())

const postScrape = (body: unknown): Request =>
  new Request('http://localhost/api/scrape', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('POST /api/scrape', () => {
  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    const req = new Request('http://localhost/api/scrape', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'keyword', keywords: ['ai'] }),
    })
    expect((await POST(req)).status).toBe(403)
  })

  it('412s with the missing keys when required settings are absent', async () => {
    const res = await POST(postScrape({ mode: 'keyword', keywords: ['ai'] }))
    expect(res.status).toBe(412)
    const body = await res.json()
    expect(body.needs).toEqual(['apify_api_token', 'voyage_api_key'])
  })

  it('412 lists only the still-missing key', async () => {
    setSettings({ apify_api_token: 'tok' }) // voyage still missing
    const res = await POST(postScrape({ mode: 'keyword', keywords: ['ai'] }))
    expect((await res.json()).needs).toEqual(['voyage_api_key'])
  })

  it('creates a running job and returns its id immediately, firing runScrape with that jobId', async () => {
    setSettings({ apify_api_token: 'tok', voyage_api_key: 'vk' })
    const res = await POST(
      postScrape({ platforms: ['linkedin'], mode: 'keyword', keywords: ['ai'], timeframe: 'week' }),
    )
    expect(res.status).toBe(202)
    const { jobId } = await res.json()
    expect(jobId).toBeTruthy()

    // job row exists and is running
    expect(getJob(jobId)!.status).toBe('running')
    // runScrape was handed the pre-created job id (PRD §10.6)
    expect(mockRunScrape).toHaveBeenCalledTimes(1)
    expect(mockRunScrape.mock.calls[0]![0]).toMatchObject({ jobId })
  })
})

describe('GET /api/scrape/[id]', () => {
  it('returns the live job row', async () => {
    const job = createJob({ mode: 'both', platforms: ['linkedin'], market: 'ai', params: {} })
    const res = await GET(new Request(`http://localhost/api/scrape/${job.id}`), { params: { id: job.id } })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('running')
  })

  it('404s for an unknown job id', async () => {
    const res = await GET(new Request('http://localhost/api/scrape/nope'), { params: { id: 'nope' } })
    expect(res.status).toBe(404)
  })
})
