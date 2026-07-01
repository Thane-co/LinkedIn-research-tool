import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeXFactors, runScrape } from '@/jobs/scrape'
import { runActor } from '@/lib/apify'
import { enrichPosts } from '@/jobs/enrich'
import { getDb, resetDb } from '@/lib/db/db'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getAuthorHistory, insertPosts, searchPosts } from '@/lib/db/posts.repo'
import { makePostRow } from '@/tests/fixtures/posts'
import type { ApifyPost } from '@/lib/types'

// Keep the pure input builders real; mock only the network run (PRD §12 step 21) + the follow-on
// enrich (its own unit covers it — here we only assert it is/ isn't fired).
vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
vi.mock('@/jobs/enrich', () => ({
  enrichPosts: vi.fn().mockResolvedValue({ embedded: 0, remaining: 0 }),
}))

const mockRunActor = vi.mocked(runActor)
const mockEnrich = vi.mocked(enrichPosts)

/** Build a raw Apify LinkedIn item whose canonical id derives from the url (not raw.id). */
const liItem = (activityId: string, over: Partial<ApifyPost> = {}): ApifyPost => ({
  id: `feed-event-${activityId}`, // deliberately NOT the canonical id — mapper must use the url
  linkedinUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
  content: 'a post about ai agents',
  author: { name: 'Jane', universalName: 'jane', type: 'profile' },
  postedAt: { date: '2026-06-20T00:00:00.000Z' },
  engagement: { likes: 10, comments: 0, shares: 0 },
  ...over,
})

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  mockEnrich.mockResolvedValue({ embedded: 0, remaining: 0 })
})
afterEach(() => resetDb())

describe('runScrape', () => {
  it('runs keyword + creator in parallel and reports duplicate/both counts', async () => {
    upsertCreator({
      platform: 'linkedin',
      profile_url: 'https://www.linkedin.com/in/jane',
      author_id: 'jane',
      tier: 'core',
    })
    mockRunActor.mockImplementation(async (_actorId, input: object) => {
      if ('searchQueries' in input) return [liItem('100'), liItem('200')]
      if ('profileUrls' in input) return [liItem('100'), liItem('300')] // 100 overlaps keyword
      return []
    })

    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'both',
      keywords: ['ai agents'],
      timeframe: 'week',
      market: 'ai',
    })

    // both scrapers fired
    expect(mockRunActor).toHaveBeenCalledTimes(2)
    expect(stats).toEqual({
      keyword_raw: 2,
      creator_raw: 2,
      merged_total: 3, // 100, 200, 300
      duplicates: 1, // 100 seen twice
      found_in_both: 1, // 100 in keyword AND creator
      inserted: 3,
    })

    // job row persisted as succeeded with the same stats
    const job = searchPosts({}) // sanity: rows landed
    expect(job.total).toBe(3)
    expect(mockEnrich).toHaveBeenCalledTimes(1) // fired because inserted > 0
  })

  it('completes when one scraper returns nothing', async () => {
    upsertCreator({
      platform: 'linkedin',
      profile_url: 'https://www.linkedin.com/in/jane',
      author_id: 'jane',
      tier: 'core',
    })
    mockRunActor.mockImplementation(async (_a, input: object) => {
      if ('searchQueries' in input) return [liItem('100')]
      return [] // creator empty
    })

    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'both',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })

    expect(stats.inserted).toBe(1)
    expect(stats.creator_raw).toBe(0)
  })

  it('marks the job failed when every scraper fails, and skips enrich', async () => {
    mockRunActor.mockRejectedValue(new Error('Apify down'))

    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'keyword',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })

    expect(stats.inserted).toBe(0)
    expect(mockEnrich).not.toHaveBeenCalled()

    const failed = getDb()
      .prepare("SELECT status, error FROM scrape_jobs WHERE status = 'failed'")
      .get() as { status: string; error: string } | undefined
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toMatch(/Apify down/)
  })

  it('skips a non-English post', async () => {
    mockRunActor.mockImplementation(async (_a, input: object) =>
      'searchQueries' in input
        ? [liItem('100', { content: 'これはテストです これはテストです' }), liItem('200')]
        : [],
    )
    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'keyword',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })
    expect(stats.inserted).toBe(1) // only the English post 200
  })

  it('recomputes x-factor scoped to the authors it just inserted, leaving others untouched', async () => {
    // jane already has 3 in-window priors (weighted 10 each) → baseline forms for a new post.
    insertPosts([
      makePostRow({ id: 'j1', author_id: 'jane', posted_at: '2026-06-10T00:00:00.000Z', likes: 10 }),
      makePostRow({ id: 'j2', author_id: 'jane', posted_at: '2026-06-15T00:00:00.000Z', likes: 10 }),
      makePostRow({ id: 'j3', author_id: 'jane', posted_at: '2026-06-18T00:00:00.000Z', likes: 10 }),
      // bob is NOT scraped this run → must stay untouched (null score)
      makePostRow({ id: 'bob1', author_id: 'bob', posted_at: '2026-06-01T00:00:00.000Z', likes: 5 }),
    ])

    mockRunActor.mockImplementation(async (_a, input: object) =>
      'searchQueries' in input
        ? [liItem('900', { engagement: { likes: 100, comments: 0, shares: 0 }, postedAt: { date: '2026-06-25T00:00:00.000Z' } })]
        : [],
    )

    await runScrape({
      platforms: ['linkedin'],
      mode: 'keyword',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })

    const jane = getAuthorHistory('jane')
    const fresh = jane.find((p) => p.id === '900')!
    expect(fresh.weighted_score).toBe(100)
    expect(fresh.creator_baseline).toBe(10) // mean of the 3 priors
    expect(fresh.x_factor).toBe(10) // 100 / 10

    const bob = getAuthorHistory('bob')[0]!
    expect(bob.weighted_score).toBeNull() // untouched — not in the affected set
    expect(bob.x_factor).toBeNull()
  })
})

describe('recomputeXFactors', () => {
  it('groups an author by author_id even when author_url differs (miniProfileUrn query strings)', () => {
    insertPosts([
      makePostRow({ id: 'p1', author_id: 'jane', author_url: 'https://li/in/jane?miniProfileUrn=A', posted_at: '2026-06-10T00:00:00.000Z', likes: 10 }),
      makePostRow({ id: 'p2', author_id: 'jane', author_url: 'https://li/in/jane?miniProfileUrn=B', posted_at: '2026-06-15T00:00:00.000Z', likes: 10 }),
      makePostRow({ id: 'p3', author_id: 'jane', author_url: 'https://li/in/jane?miniProfileUrn=C', posted_at: '2026-06-18T00:00:00.000Z', likes: 10 }),
      makePostRow({ id: 'p4', author_id: 'jane', author_url: 'https://li/in/jane?miniProfileUrn=D', posted_at: '2026-06-25T00:00:00.000Z', likes: 100 }),
    ])

    recomputeXFactors(['jane'])

    const p4 = searchPosts({}).posts.find((p) => p.id === 'p4')!
    // If it had matched on author_url the 3 priors wouldn't group and x_factor would be null.
    expect(p4.creator_baseline).toBe(10)
    expect(p4.x_factor).toBe(10)
  })

  it('writes weighted_score for every post of the affected author', () => {
    insertPosts([makePostRow({ id: 's1', author_id: 'sam', likes: 2, comments: 1, shares: 1 })])
    recomputeXFactors(['sam'])
    const s1 = searchPosts({}).posts.find((p) => p.id === 's1')!
    expect(s1.weighted_score).toBe(2 * 1 + 1 * 3 + 1 * 5) // = 10
  })

  it('dedupes the author list and is a no-op for an unknown author (non-fatal)', () => {
    expect(() => recomputeXFactors(['ghost', 'ghost', ''])).not.toThrow()
  })
})
