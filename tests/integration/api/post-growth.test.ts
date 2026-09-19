import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/post-growth/route'
import { POST } from '@/app/api/post-growth/refresh/route'
import { refreshRecentEngagement } from '@/jobs/refresh-engagement'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'

vi.mock('@/jobs/refresh-engagement', () => ({ refreshRecentEngagement: vi.fn() }))
const mockRefresh = vi.mocked(refreshRecentEngagement)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
})
afterEach(() => resetDb())

const get = (url: string): Request => new Request(`http://localhost${url}`)

describe('GET /api/post-growth', () => {
  it('returns the recent-post growth list', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://li/in/jane', author_id: 'jane' })
    const res = await GET(get('/api/post-growth?days=7'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ days: 7, posts: [] })
  })

  it('defaults to a 7-day window', async () => {
    expect((await (await GET(get('/api/post-growth'))).json()).days).toBe(7)
  })

  it('400s an out-of-range window rather than scanning the whole corpus', async () => {
    expect((await GET(get('/api/post-growth?days=0'))).status).toBe(400)
    expect((await GET(get('/api/post-growth?days=400'))).status).toBe(400)
  })

  it('400s a malformed asOf instead of silently using today', async () => {
    expect((await GET(get('/api/post-growth?asOf=today'))).status).toBe(400)
  })

  it('scopes to one creator when asked, and reports their median day-1', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://li/in/jane', author_id: 'jane' })
    const body = await (await GET(get('/api/post-growth?authorId=jane'))).json()
    expect(body).toMatchObject({ author_id: 'jane', median_day1: null })
  })
})

describe('POST /api/post-growth/refresh', () => {
  const post = (origin?: string): Request =>
    new Request('http://localhost/api/post-growth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    })

  it('refuses a cross-origin request with 403', async () => {
    expect((await POST(post('https://evil.example.com'))).status).toBe(403)
  })

  it('412s when the Apify token is missing', async () => {
    const res = await POST(post())
    expect(res.status).toBe(412)
    expect((await res.json()).needs).toEqual(['apify_api_token'])
  })

  it('runs the refresh and returns its report including the cost', async () => {
    setSettings({ apify_api_token: 'tok' })
    mockRefresh.mockResolvedValue({
      captured_on: '2026-09-10', creators: 55, posts_returned: 476,
      snapshots: 476, new_posts: 12, rescored: 476, cost_usd: 0.952, errors: [],
    })
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ posts_returned: 476, cost_usd: 0.952 })
  })

  it('502s when the refresh throws', async () => {
    setSettings({ apify_api_token: 'tok' })
    mockRefresh.mockRejectedValue(new Error('no actor configured'))
    expect((await POST(post())).status).toBe(502)
  })
})
