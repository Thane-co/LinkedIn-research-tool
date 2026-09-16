// Layer 4 — GET /api/scrape/status + POST /api/creators/backfill-personas (PRD §11.8).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as getStatus } from '@/app/api/scrape/status/route'
import { POST as backfill } from '@/app/api/creators/backfill-personas/route'
import { POST as postScrapeRoute } from '@/app/api/scrape/route'
import { runScrape } from '@/jobs/scrape'
import { getDb, resetDb } from '@/lib/db/db'
import { listCreators, upsertCreator } from '@/lib/db/creators.repo'
import { insertPosts } from '@/lib/db/posts.repo'
import { makePostRow } from '@/tests/fixtures/posts'
import { setSettings } from '@/lib/settings'

vi.mock('@/jobs/scrape', () => ({ runScrape: vi.fn().mockResolvedValue(undefined) }))
const mockRunScrape = vi.mocked(runScrape)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  mockRunScrape.mockResolvedValue(undefined as never)
})
afterEach(() => resetDb())

const statusReq = new Request('http://localhost/api/scrape/status')
const backfillReq = (): Request =>
  new Request('http://localhost/api/creators/backfill-personas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })

describe('GET /api/scrape/status', () => {
  it('reports last scrape and creator count for every platform, even empty ones', async () => {
    const body = await (await getStatus(statusReq)).json()
    expect(Object.keys(body.platforms).sort()).toEqual(['instagram', 'linkedin', 'substack', 'twitter'])
    expect(body.platforms.twitter).toEqual({ lastScrapedAt: null, creators: 0 })
  })

  it('counts creators per platform and surfaces the newest scraped_at', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://a.test' })
    upsertCreator({ platform: 'linkedin', profile_url: 'https://b.test' })
    insertPosts([
      makePostRow({ id: 'p1', platform: 'linkedin', scraped_at: '2026-09-01T00:00:00.000Z' }),
      makePostRow({ id: 'p2', platform: 'linkedin', scraped_at: '2026-09-04T00:00:00.000Z' }),
    ])
    const body = await (await getStatus(statusReq)).json()
    expect(body.platforms.linkedin).toEqual({ lastScrapedAt: '2026-09-04T00:00:00.000Z', creators: 2 })
  })
})

describe('POST /api/creators/backfill-personas', () => {
  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    const req = new Request('http://localhost/api/creators/backfill-personas', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    })
    expect((await backfill(req)).status).toBe(403)
  })

  it('fills personas and returns the refreshed creator list', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://a.test', display_name: 'Luna Chen' })
    const body = await (await backfill(backfillReq())).json()
    expect(body.updated).toBe(1)
    expect(body.creators).toHaveLength(1)
    expect(listCreators().creators[0]!.persona).toBe('luna chen')
  })
})

describe('POST /api/scrape — per-platform options', () => {
  it('forwards minimumFavorites to runScrape', async () => {
    setSettings({ apify_api_token: 't', voyage_api_key: 'v' })
    const res = await postScrapeRoute(
      new Request('http://localhost/api/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'keyword', platforms: ['twitter'], keywords: ['ai'], minimumFavorites: 250 }),
      }),
    )
    expect(res.status).toBe(202)
    expect(mockRunScrape).toHaveBeenCalledWith(expect.objectContaining({ minimumFavorites: 250, platforms: ['twitter'] }))
  })

  it('leaves minimumFavorites undefined when the client omits it', async () => {
    setSettings({ apify_api_token: 't', voyage_api_key: 'v' })
    await postScrapeRoute(
      new Request('http://localhost/api/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'keyword', platforms: ['twitter'], keywords: ['ai'] }),
      }),
    )
    expect(mockRunScrape.mock.calls[0]![0].minimumFavorites).toBeUndefined()
  })
})
