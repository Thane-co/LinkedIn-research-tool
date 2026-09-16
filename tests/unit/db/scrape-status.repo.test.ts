// Layer 2 — per-platform scrape status + persona backfill (PRD §11.8).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { backfillPersonas, listCreators, upsertCreator } from '@/lib/db/creators.repo'
import { getLastScrapeByPlatform, insertPosts } from '@/lib/db/posts.repo'
import type { PostRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

let n = 0
const post = (over: Partial<PostRow>): PostRow =>
  ({
    id: `p${++n}`,
    platform: 'linkedin',
    url: null,
    content: 'x',
    author_name: null,
    author_url: null,
    author_id: 'a',
    author_type: 'profile',
    likes: 0,
    shares: 0,
    comments: 0,
    posted_at: '2026-01-01T00:00:00.000Z',
    scraped_at: '2026-01-01T00:00:00.000Z',
    is_repost: 0,
    scrape_source: null,
    market: 'ai',
    media: null,
    image_url: null,
    raw_data: '{}',
    transcript: null,
    embedding: null,
    image_description: null,
    image_embedding: null,
    embedded_at: null,
    weighted_score: null,
    creator_baseline: null,
    x_factor: null,
    ...over,
  }) as PostRow

describe('getLastScrapeByPlatform', () => {
  it('returns null for every platform when nothing has been scraped', () => {
    expect(getLastScrapeByPlatform()).toEqual({ linkedin: null, twitter: null, substack: null, instagram: null })
  })

  it('reports the most recent scraped_at per platform', () => {
    insertPosts([
      post({ platform: 'linkedin', scraped_at: '2026-09-01T00:00:00.000Z' }),
      post({ platform: 'linkedin', scraped_at: '2026-09-04T00:00:00.000Z' }),
      post({ platform: 'twitter', scraped_at: '2026-08-20T00:00:00.000Z' }),
    ])
    const last = getLastScrapeByPlatform()
    expect(last.linkedin).toBe('2026-09-04T00:00:00.000Z')
    expect(last.twitter).toBe('2026-08-20T00:00:00.000Z')
    expect(last.substack).toBeNull()
    expect(last.instagram).toBeNull()
  })
})

describe('backfillPersonas', () => {
  it('fills persona from the display name for rows that have none', () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://a.test', display_name: 'Luna Chen' })
    expect(backfillPersonas()).toEqual({ updated: 1 })
    expect(listCreators().creators[0]!.persona).toBe('luna chen')
  })

  it('never overwrites a persona that is already set', () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://a.test', display_name: 'Luna Chen', persona: 'mine' })
    expect(backfillPersonas()).toEqual({ updated: 0 })
    expect(listCreators().creators[0]!.persona).toBe('mine')
  })

  it('leaves a row alone when the display name yields no key', () => {
    upsertCreator({ platform: 'twitter', profile_url: 'https://b.test', display_name: null })
    upsertCreator({ platform: 'twitter', profile_url: 'https://c.test', display_name: '!!!' })
    expect(backfillPersonas()).toEqual({ updated: 0 })
    expect(listCreators().creators.every((c) => c.persona === null)).toBe(true)
  })

  it('links two accounts for the same person onto one persona key', () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://a.test', display_name: 'Addy Osmani' })
    upsertCreator({ platform: 'twitter', profile_url: 'https://b.test', display_name: 'addy osmani' })
    expect(backfillPersonas()).toEqual({ updated: 2 })
    const personas = listCreators().creators.map((c) => c.persona)
    expect(new Set(personas).size).toBe(1)
  })

  it('is idempotent — a second run changes nothing', () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://a.test', display_name: 'Luna Chen' })
    backfillPersonas()
    expect(backfillPersonas()).toEqual({ updated: 0 })
  })
})
