import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import {
  buildLinkedInCreatorInput,
  buildLinkedInKeywordInput,
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

  it('LinkedIn creator: profileUrls + date sort + a per-profile cap', () => {
    const input = buildLinkedInCreatorInput(['https://li/in/jane'], 'month') as Record<string, unknown>
    expect(input.profileUrls).toEqual(['https://li/in/jane'])
    expect(input.sortBy).toBe('date')
    expect(typeof input.maxPostsPerProfile).toBe('number')
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
