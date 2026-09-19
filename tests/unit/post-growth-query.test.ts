import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { recordPostSnapshots } from '@/lib/db/post-snapshots.repo'
import { insertPosts } from '@/lib/db/posts.repo'
import { creatorPostGrowth, recentPostGrowth } from '@/lib/post-growth-query'
import type { PostRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const creator = (author_id: string) =>
  upsertCreator({
    platform: 'linkedin', profile_url: `https://www.linkedin.com/in/${author_id}`,
    author_id, display_name: author_id,
  })

const post = (id: string, author_id: string, posted_at: string): PostRow =>
  ({
    id, platform: 'linkedin', url: `https://li/${id}`, content: `post ${id}`,
    author_name: author_id, author_url: null, author_id, author_type: 'profile',
    likes: 0, shares: 0, comments: 0, posted_at, scraped_at: posted_at,
    is_repost: 0, scrape_source: 'creator', market: 'ai', media: null, transcript: null,
    embedding: null, image_url: null, image_description: null, image_embedding: null,
    embedded_at: null, weighted_score: 0, creator_baseline: null, x_factor: null, x_score: null, creator_spread: null, x_provisional: 0, measured_at: null, raw_data: null,
  }) as unknown as PostRow

const cap = (post_id: string, day: string, likes: number) =>
  recordPostSnapshots([
    { post_id, captured_on: day, captured_at: `${day}T06:00:00.000Z`, likes, comments: 0, shares: 0 },
  ])

describe('recentPostGrowth', () => {
  it('returns each recent post with its day-1/2/3 totals', () => {
    creator('jane')
    insertPosts([post('p1', 'jane', '2026-09-07T06:00:00.000Z')])
    cap('p1', '2026-09-08', 100)
    cap('p1', '2026-09-09', 160)
    cap('p1', '2026-09-10', 175)

    const rows = recentPostGrowth({ days: 7, asOf: '2026-09-10' })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'p1', author_id: 'jane', day1: 100, day2: 160, day3: 175 })
  })

  it('includes a post with no snapshots yet, with null growth rather than zeros', () => {
    creator('jane')
    insertPosts([post('fresh', 'jane', '2026-09-10T06:00:00.000Z')])

    const [row] = recentPostGrowth({ days: 7, asOf: '2026-09-10' })
    expect(row).toMatchObject({ id: 'fresh', day1: null, day2: null, day3: null })
  })

  it('excludes posts older than the window', () => {
    creator('jane')
    insertPosts([post('old', 'jane', '2026-08-01T06:00:00.000Z')])
    expect(recentPostGrowth({ days: 7, asOf: '2026-09-10' })).toEqual([])
  })

  it('only covers roster creators — a keyword-scrape author is not being re-measured', () => {
    insertPosts([post('stranger', 'someone-else', '2026-09-09T06:00:00.000Z')])
    expect(recentPostGrowth({ days: 7, asOf: '2026-09-10' })).toEqual([])
  })

  it('sorts by what arrived most recently, so today\'s movers are on top', () => {
    creator('jane')
    insertPosts([
      post('slow', 'jane', '2026-09-08T06:00:00.000Z'),
      post('fast', 'jane', '2026-09-08T06:00:00.000Z'),
    ])
    cap('slow', '2026-09-09', 100)
    cap('slow', '2026-09-10', 105) // +5
    cap('fast', '2026-09-09', 100)
    cap('fast', '2026-09-10', 400) // +300

    const rows = recentPostGrowth({ days: 7, asOf: '2026-09-10' })
    expect(rows.map((r) => r.id)).toEqual(['fast', 'slow'])
    expect(rows[0]?.gained_today).toBe(300)
  })
})

describe('creatorPostGrowth', () => {
  it('compares a creator\'s last 3 days of posts against each other', () => {
    creator('jane')
    insertPosts([
      post('d1', 'jane', '2026-09-08T06:00:00.000Z'),
      post('d2', 'jane', '2026-09-09T06:00:00.000Z'),
      post('d3', 'jane', '2026-09-10T06:00:00.000Z'),
    ])
    cap('d1', '2026-09-09', 500)
    cap('d2', '2026-09-10', 200)

    const out = creatorPostGrowth('jane', { days: 3, asOf: '2026-09-10' })

    expect(out.author_id).toBe('jane')
    expect(out.posts.map((p) => p.id).sort()).toEqual(['d1', 'd2', 'd3'])
  })

  it('reports the creator\'s median day-1 engagement as a yardstick for a new post', () => {
    creator('jane')
    insertPosts([
      post('a', 'jane', '2026-09-06T06:00:00.000Z'),
      post('b', 'jane', '2026-09-07T06:00:00.000Z'),
      post('c', 'jane', '2026-09-08T06:00:00.000Z'),
    ])
    cap('a', '2026-09-07', 100)
    cap('b', '2026-09-08', 200)
    cap('c', '2026-09-09', 300)

    const out = creatorPostGrowth('jane', { days: 30, asOf: '2026-09-10' })
    expect(out.median_day1).toBe(200)
  })

  it('leaves the yardstick null when nothing has reached day 1 yet', () => {
    creator('jane')
    insertPosts([post('fresh', 'jane', '2026-09-10T06:00:00.000Z')])
    expect(creatorPostGrowth('jane', { days: 30, asOf: '2026-09-10' }).median_day1).toBeNull()
  })

  it('is empty, not an error, for a creator with no posts in the window', () => {
    creator('ghost')
    expect(creatorPostGrowth('ghost', { days: 3, asOf: '2026-09-10' })).toMatchObject({ posts: [] })
  })
})
