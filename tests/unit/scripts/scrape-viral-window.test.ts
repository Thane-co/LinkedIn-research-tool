import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScrape } from '@/jobs/scrape'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts } from '@/lib/db/posts.repo'
import { run } from '@/scripts/scrape-viral-window'
import { makePostRow } from '@/tests/fixtures/posts'
import type { ScrapeStats } from '@/lib/types'

// The job layer is mocked: the script's job is to drive runScrape headless and then read the DB.
vi.mock('@/jobs/scrape', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/scrape')>()
  return { ...actual, runScrape: vi.fn() }
})
const mockRunScrape = vi.mocked(runScrape)

const ZERO: ScrapeStats = {
  keyword_raw: 0,
  creator_raw: 0,
  merged_total: 0,
  duplicates: 0,
  found_in_both: 0,
  inserted: 0,
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString()

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  mockRunScrape.mockResolvedValue(ZERO)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  resetDb()
  vi.restoreAllMocks()
})

describe('scrape-viral-window run()', () => {
  it('re-scrapes all core LinkedIn creators over the 3-day window', async () => {
    await run()
    expect(mockRunScrape).toHaveBeenCalledTimes(1)
    expect(mockRunScrape.mock.calls[0]![0]).toMatchObject({
      mode: 'creator',
      platforms: ['linkedin'],
      timeframe: '3d',
      creatorIds: undefined,
    })
  })

  it('returns recent LinkedIn posts, best x_score first, excluding old and non-LinkedIn', async () => {
    insertPosts([
      makePostRow({ id: 'a', platform: 'linkedin', posted_at: isoAgo(2 * HOUR), x_score: 4, likes: 100 }),
      makePostRow({ id: 'b', platform: 'linkedin', posted_at: isoAgo(3 * HOUR), x_score: 2, likes: 900 }),
      makePostRow({ id: 'old', platform: 'linkedin', posted_at: isoAgo(5 * DAY), x_score: 9, likes: 9 }),
      makePostRow({ id: 'tw', platform: 'twitter', posted_at: isoAgo(1 * HOUR), x_score: 9, likes: 9 }),
    ])
    const { posts } = await run()
    expect(posts.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('does not throw when the scrape returns zero (partial/total failure surfaces as stats)', async () => {
    mockRunScrape.mockResolvedValue(ZERO)
    await expect(run()).resolves.toBeDefined()
  })
})
