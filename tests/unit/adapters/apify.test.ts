import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import {
  buildInstagramCreatorInput,
  buildLinkedInCommentsInput,
  buildLinkedInCreatorInput,
  buildLinkedInKeywordInput,
  buildLinkedInProfileInput,
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

describe('buildLinkedInCommentsInput (§23)', () => {
  it('sends the post urls and asks for every comment (maxItems 0), replies included', () => {
    expect(buildLinkedInCommentsInput(['https://li/p/1', 'https://li/p/2'])).toEqual({
      posts: ['https://li/p/1', 'https://li/p/2'],
      maxItems: 0,
      scrapeReplies: true,
    })
  })
})

describe('input builders (pure)', () => {
  it('LinkedIn keyword: searchQueries + relevance sort + maxPosts 200, reactions/comments off', () => {
    const input = buildLinkedInKeywordInput(['ai agents'], 'week') as Record<string, unknown>
    expect(input.searchQueries).toEqual(['ai agents'])
    expect(input.sortBy).toBe('relevance')
    expect(input.maxPosts).toBe(200)
    expect(input.scrapeComments).toBe(false)
    expect(input.scrapeReactions).toBe(false)
    expect(input.postedLimit).toBe('week')
  })

  it('LinkedIn keyword: maps each timeframe to the actor postedLimit enum (no "past-" prefix)', () => {
    // harvestapi/linkedin-post-search rejects "past-week" etc: Field input.postedLimit must be
    // equal to one of "any", "1h", "24h", "week", "month", "3months", "6months", "year" (confirmed
    // from the actor's live 400 response) — same enum shape as the profile actor, not the "past-X"
    // strings this used to send, which made every LinkedIn keyword scrape silently return 0 posts.
    const limitFor = (tf: Parameters<typeof buildLinkedInKeywordInput>[1]): unknown =>
      (buildLinkedInKeywordInput(['ai'], tf) as Record<string, unknown>).postedLimit
    expect(limitFor('all')).toBe('any')
    expect(limitFor('24h')).toBe('24h')
    expect(limitFor('3d')).toBe('week') // no 3-day option on the actor
    expect(limitFor('week')).toBe('week')
    expect(limitFor('month')).toBe('month')
    expect(limitFor('3months')).toBe('3months')
    expect(limitFor('custom')).toBe('any')
  })

  it('LinkedIn creator: targetUrls + a post cap (maxPosts) + a DATE bound (postedLimit)', () => {
    const input = buildLinkedInCreatorInput(['https://li/in/jane'], 'month') as Record<string, unknown>
    // Actor input keys are targetUrls + maxPosts — the exact names harvestapi expects (wrong names
    // are silently ignored and the actor caps at its ~50-post default).
    expect(input.targetUrls).toEqual(['https://li/in/jane'])
    expect(typeof input.maxPosts).toBe('number')
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

  it('Instagram creator: username targets + resultsLimit cap (§18)', () => {
    const input = buildInstagramCreatorInput(['https://www.instagram.com/natgeo/'], 'month') as Record<string, unknown>
    expect(input.username).toEqual(['https://www.instagram.com/natgeo/']) // actor accepts profile urls or handles
    expect(typeof input.resultsLimit).toBe('number')
    expect('searchQueries' in input).toBe(false) // the post scraper is profile-driven, not keyword
  })

  it('Instagram creator: passes onlyPostsNewerThan when a date bound is given, omits it otherwise', () => {
    const bounded = buildInstagramCreatorInput(['natgeo'], 'week', { onlyNewerThan: '2026-07-10' }) as Record<string, unknown>
    expect(bounded.onlyPostsNewerThan).toBe('2026-07-10')

    const unbounded = buildInstagramCreatorInput(['natgeo'], 'all') as Record<string, unknown>
    expect('onlyPostsNewerThan' in unbounded).toBe(false)
    expect(unbounded.resultsLimit).toBe(500) // 'all' = full history at the actor ceiling
  })

  it('LinkedIn profile (§19): queries (urls or handles) + the details-only scraper mode', () => {
    const input = buildLinkedInProfileInput(['https://www.linkedin.com/in/basiakubicka/']) as Record<string, unknown>
    expect(input.queries).toEqual(['https://www.linkedin.com/in/basiakubicka/']) // accepts urls OR bare public ids
    expect(input.profileScraperMode).toBe('Profile details no email ($4 per 1k)') // cheaper, no email lookup
    expect('urls' in input).toBe(false) // the actor keys off `queries`, not `urls`
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

  it('honors a raised maxPolls ceiling: keeps polling past the default before succeeding (§18)', async () => {
    setSettings({ apify_api_token: 'tok' })
    let polls = 0
    server.use(
      http.post(`${BASE}/acts/:actor/runs`, () =>
        HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'RUNNING' } }),
      ),
      http.get(`${BASE}/actor-runs/run1`, () => {
        polls += 1
        // Stay RUNNING for the first 5 polls (more than a tiny default would allow), then finish.
        return HttpResponse.json({ data: { id: 'run1', status: polls >= 6 ? 'SUCCEEDED' : 'RUNNING' } })
      }),
      http.get(`${BASE}/datasets/ds1/items`, () => HttpResponse.json([{ shortCode: 'x', fullText: 't' }])),
    )
    vi.useFakeTimers()
    try {
      const p = runActor('crawlerbros/instagram-transcript-scraper', {}, { maxPolls: 50 })
      await vi.advanceTimersByTimeAsync(10 * 1500 + 100)
      await expect(p).resolves.toEqual([{ shortCode: 'x', fullText: 't' }])
      expect(polls).toBeGreaterThanOrEqual(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates transient network errors during polling and still completes (§18 resilience)', async () => {
    setSettings({ apify_api_token: 'tok' })
    let polls = 0
    server.use(
      http.post(`${BASE}/acts/:actor/runs`, () =>
        HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'RUNNING' } }),
      ),
      http.get(`${BASE}/actor-runs/run1`, () => {
        polls += 1
        if (polls <= 3) return HttpResponse.error() // transient network blips
        return HttpResponse.json({ data: { id: 'run1', status: 'SUCCEEDED' } })
      }),
      http.get(`${BASE}/datasets/ds1/items`, () => HttpResponse.json([{ shortCode: 'x', fullText: 't' }])),
    )
    vi.useFakeTimers()
    try {
      const p = runActor('crawlerbros/instagram-transcript-scraper', {})
      await vi.advanceTimersByTimeAsync(6 * 1500 + 100)
      await expect(p).resolves.toEqual([{ shortCode: 'x', fullText: 't' }])
      expect(polls).toBeGreaterThanOrEqual(4) // retried past the blips
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after too many CONSECUTIVE poll network errors', async () => {
    setSettings({ apify_api_token: 'tok' })
    server.use(
      http.post(`${BASE}/acts/:actor/runs`, () =>
        HttpResponse.json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'RUNNING' } }),
      ),
      http.get(`${BASE}/actor-runs/run1`, () => HttpResponse.error()), // never recovers
    )
    vi.useFakeTimers()
    try {
      const expectation = expect(runActor('some/actor', {})).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(10 * 1500 + 100)
      await expectation
    } finally {
      vi.useRealTimers()
    }
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
