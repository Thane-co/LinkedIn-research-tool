import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import {
  buildLinkedInCreatorInput,
  buildLinkedInKeywordInput,
  buildSubstackCreatorInput,
  buildSubstackKeywordInput,
  buildTwitterCreatorInput,
  buildTwitterKeywordInput,
  runActor,
} from '@/lib/apify'
import { server } from '@/tests/msw/server'

beforeEach(() => {
  getDb(':memory:')
})
afterEach(() => resetDb())

describe('input builders (pure)', () => {
  it('LinkedIn keyword: searchQueries + relevance sort + maxPosts 200, reactions/comments off', () => {
    const input = buildLinkedInKeywordInput(['ai agents'], 'week') as Record<string, unknown>
    expect(input.searchQueries).toEqual(['ai agents'])
    expect(input.sortBy).toBe('relevance')
    expect(input.maxPosts).toBe(200)
    expect(input.scrapeComments).toBe(false)
    expect(input.scrapeReactions).toBe(false)
    expect(typeof input.postedLimit).toBe('string')
  })

  it('LinkedIn creator: profileUrls + date sort + a per-profile cap + a DATE bound (postedLimit)', () => {
    const input = buildLinkedInCreatorInput(['https://li/in/jane'], 'month') as Record<string, unknown>
    expect(input.profileUrls).toEqual(['https://li/in/jane'])
    expect(input.sortBy).toBe('date')
    expect(typeof input.maxPostsPerProfile).toBe('number')
    expect(input.postedLimit).toBe('month') // bounds by date, not just count (no re-paying for old posts)
  })

  it('LinkedIn creator: maps each timeframe to the profile actor postedLimit enum', () => {
    const limitFor = (tf: Parameters<typeof buildLinkedInCreatorInput>[1]): unknown =>
      (buildLinkedInCreatorInput(['u'], tf) as Record<string, unknown>).postedLimit
    expect(limitFor('week')).toBe('week')
    expect(limitFor('24h')).toBe('24h')
    expect(limitFor('3d')).toBe('week') // no 3-day option on the actor
    expect(limitFor('3months')).toBe('3months')
    expect(limitFor('all')).toBe('any')
  })

  it('Twitter keyword: searchTerms + Top sort + maxItems 200, optional filters passed through', () => {
    const input = buildTwitterKeywordInput(['ai'], {
      minimumFavorites: 50,
      start: '2026-06-01',
      tweetLanguage: 'en',
    }) as Record<string, unknown>
    expect(input.searchTerms).toEqual(['ai'])
    expect(input.sort).toBe('Top')
    expect(input.maxItems).toBe(200)
    expect(input.minimumFavorites).toBe(50)
    expect(input.start).toBe('2026-06-01')
    expect(input.tweetLanguage).toBe('en')
  })

  it('Twitter creator: twitterHandles + Latest sort + maxItems 50 (same actor, different shape)', () => {
    const input = buildTwitterCreatorInput(['jane']) as Record<string, unknown>
    expect(input.twitterHandles).toEqual(['jane'])
    expect(input.sort).toBe('Latest')
    expect(input.maxItems).toBe(50)
  })

  it('omits optional Twitter filters when not provided', () => {
    const input = buildTwitterKeywordInput(['ai']) as Record<string, unknown>
    expect('minimumFavorites' in input).toBe(false)
    expect('start' in input).toBe(false)
  })

  it('Substack keyword: searchQueries + maxSearchResults + a per-publication cap', () => {
    const input = buildSubstackKeywordInput(['ai agents'], 'week') as Record<string, unknown>
    expect(input.searchQueries).toEqual(['ai agents'])
    expect(input.maxSearchResults).toBe(25)
    expect(typeof input.maxPostsPerPublication).toBe('number')
  })

  it('Substack creator: posts-only by default (publicationHandles, NO notes/userHandles)', () => {
    const input = buildSubstackCreatorInput(['laraacosta'], 'month') as Record<string, unknown>
    expect(input.publicationHandles).toEqual(['laraacosta']) // articles/posts
    expect(typeof input.maxPostsPerPublication).toBe('number')
    expect('userHandles' in input).toBe(false) // Notes are opt-in (slower)
    expect('maxNotesPerAuthor' in input).toBe(false)
    expect('searchQueries' in input).toBe(false)
    expect('urls' in input).toBe(false) // a user-profile url returns nothing; target by handle
  })

  it('Substack creator: includeNotes sets the actor flag + userHandles (Notes) feed + its cap', () => {
    const input = buildSubstackCreatorInput(['laraacosta'], 'month', { includeNotes: true }) as Record<string, unknown>
    expect(input.userHandles).toEqual(['laraacosta'])
    expect(input.includeNotes).toBe(true) // the actor's own flag — without it, no notes are scraped
    expect(typeof input.maxNotesPerAuthor).toBe('number')
  })

  it('Substack creator "all" = full history: caps at the actor ceiling (500) with no date bound', () => {
    const input = buildSubstackCreatorInput(['laraacosta'], 'all', { includeNotes: true }) as Record<string, unknown>
    expect(input.maxPostsPerPublication).toBe(500)
    expect(input.maxNotesPerAuthor).toBe(500)
    expect('dateFrom' in input).toBe(false)
  })

  it('Substack: passes optional date range + minReactions through, omits them otherwise', () => {
    const withOpts = buildSubstackKeywordInput(['ai'], 'week', {
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      minReactions: 100,
    }) as Record<string, unknown>
    expect(withOpts.dateFrom).toBe('2026-06-01')
    expect(withOpts.dateTo).toBe('2026-06-30')
    expect(withOpts.minReactions).toBe(100)

    const bare = buildSubstackCreatorInput(['laraacosta'], 'week') as Record<string, unknown>
    expect('dateFrom' in bare).toBe(false)
    expect('minReactions' in bare).toBe(false)
  })
})

const BASE = 'https://api.apify.com/v2'

describe('runActor', () => {
  it('throws a clear error when the Apify token is unset', async () => {
    await expect(runActor('some/actor', {})).rejects.toThrow(/apify/i)
  })

  it('starts a run, polls to SUCCEEDED, and returns the dataset items', async () => {
    setSettings({ apify_api_token: 'tok' })
    const items = [{ id: '1' }, { id: '2' }]
    server.use(
      http.post(`${BASE}/acts/:actor/runs`, () =>
        HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'RUNNING' } }),
      ),
      http.get(`${BASE}/actor-runs/run1`, () =>
        HttpResponse.json({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } }),
      ),
      http.get(`${BASE}/datasets/ds1/items`, () => HttpResponse.json(items)),
    )
    await expect(runActor('harvestapi/linkedin-post-search', { searchQueries: ['ai'] })).resolves.toEqual(
      items,
    )
  })

  it('throws when the run terminates in a FAILED status', async () => {
    setSettings({ apify_api_token: 'tok' })
    server.use(
      http.post(`${BASE}/acts/:actor/runs`, () =>
        HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'RUNNING' } }),
      ),
      http.get(`${BASE}/actor-runs/run1`, () =>
        HttpResponse.json({ data: { id: 'run1', status: 'FAILED', defaultDatasetId: 'ds1' } }),
      ),
    )
    await expect(runActor('some/actor', {})).rejects.toThrow(/failed/i)
  })

  it('throws a timeout error (never fetches a partial dataset) when the run never reaches SUCCEEDED', async () => {
    // Regression: exhausting the poll ceiling must FAIL the run, not fall through and fetch an
    // incomplete/empty dataset that would be reported as a silently-wrong success (PRD §10.7).
    vi.useFakeTimers()
    try {
      setSettings({ apify_api_token: 'tok' })
      let itemsFetched = false
      server.use(
        http.post(`${BASE}/acts/:actor/runs`, () =>
          HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'RUNNING' } }),
        ),
        http.get(`${BASE}/actor-runs/run1`, () =>
          HttpResponse.json({ data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } }),
        ),
        http.get(`${BASE}/datasets/ds1/items`, () => {
          itemsFetched = true
          return HttpResponse.json([])
        }),
      )
      const expectation = expect(runActor('some/actor', {})).rejects.toThrow(/within|finish|timeout/i)
      // Drive well past the ~10-min ceiling (400 polls x 1500 ms) to exhaust the loop.
      await vi.advanceTimersByTimeAsync(400 * 1500 + 5000)
      await expectation
      expect(itemsFetched).toBe(false) // never reached the dataset fetch
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a hung request via its per-fetch timeout instead of blocking forever', async () => {
    vi.useFakeTimers()
    try {
      setSettings({ apify_api_token: 'tok' })
      server.use(
        http.post(`${BASE}/acts/:actor/runs`, () => new Promise<Response>(() => {})), // never resolves
      )
      const expectation = expect(runActor('some/actor', {})).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(31_000) // past START_TIMEOUT_MS (30 s)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('encodes the actor id (slash -> tilde) in the run URL', async () => {
    setSettings({ apify_api_token: 'tok' })
    let calledPath = ''
    server.use(
      http.post(`${BASE}/acts/:actor/runs`, ({ params }) => {
        calledPath = params.actor as string
        return HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'SUCCEEDED' } })
      }),
      http.get(`${BASE}/actor-runs/run1`, () =>
        HttpResponse.json({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } }),
      ),
      http.get(`${BASE}/datasets/ds1/items`, () => HttpResponse.json([])),
    )
    await runActor('harvestapi/linkedin-post-search', {})
    expect(calledPath).toBe('harvestapi~linkedin-post-search')
  })
})
