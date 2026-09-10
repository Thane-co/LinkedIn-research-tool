import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLeaderboard, creatorGrowthDetail } from '@/lib/followers-query'
import { setCreatorTracking, upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { recordSnapshot } from '@/lib/db/followers.repo'
import { insertPosts } from '@/lib/db/posts.repo'
import type { PostRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

// §21.8 — the board shows the TRACKED subset, so fixtures opt in unless a test says otherwise.
const creator = (author_id: string, display_name = author_id, tracked = true) => {
  const row = upsertCreator({
    platform: 'linkedin',
    profile_url: `https://www.linkedin.com/in/${author_id}`,
    author_id,
    display_name,
  })
  if (tracked) setCreatorTracking(row.id, true)
  return row
}

const cap = (author_id: string, day: string, followers: number) =>
  recordSnapshot({
    author_id,
    platform: 'linkedin',
    captured_on: day,
    captured_at: `${day}T06:00:00.000Z`,
    followers,
    connections: null,
    source: 'profile-actor',
  })

const post = (id: string, author_id: string, posted_at: string, x_factor: number | null = null): PostRow =>
  ({
    id,
    platform: 'linkedin',
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    content: `post ${id}`,
    author_name: author_id,
    author_url: `https://www.linkedin.com/in/${author_id}`,
    author_id,
    author_type: 'profile',
    likes: 10,
    shares: 0,
    comments: 0,
    posted_at,
    scraped_at: '2026-09-09T00:00:00.000Z',
    is_repost: 0,
    scrape_source: 'creator',
    market: 'ai',
    media: null,
    transcript: null,
    embedding: null,
    image_url: null,
    image_description: null,
    image_embedding: null,
    embedded_at: null,
    weighted_score: 10,
    creator_baseline: null,
    x_factor,
    raw_data: null,
  }) as unknown as PostRow

describe('buildLeaderboard', () => {
  it('places every core LinkedIn creator on the absolute board, measured or not', () => {
    creator('jane')
    creator('bob')
    creator('newbie')
    cap('jane', '2026-09-08', 20_000)
    cap('jane', '2026-09-09', 20_500)
    cap('bob', '2026-09-08', 50_000)
    cap('bob', '2026-09-09', 50_100)
    cap('newbie', '2026-09-09', 800) // one capture only, no delta possible

    const board = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' })

    expect(board.absolute).toHaveLength(3)
    expect(board.absolute.map((r) => r.author_id)).toEqual(['jane', 'bob', 'newbie'])
    expect(board.absolute[0]).toMatchObject({ rank: 1, gained: 500, followers: 20_500 })
    expect(board.absolute[2]).toMatchObject({ author_id: 'newbie', gained: null })
  })

  it('keeps sub-floor accounts off the percent board but on the absolute one', () => {
    creator('small')
    creator('big')
    cap('small', '2026-09-08', 500)
    cap('small', '2026-09-09', 600) // +20%
    cap('big', '2026-09-08', 50_000)
    cap('big', '2026-09-09', 50_500) // +1%

    const board = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' })

    expect(board.percent_floor).toBe(10_000)
    expect(board.percent.map((r) => r.author_id)).toEqual(['big'])
    expect(board.absolute.map((r) => r.author_id)).toEqual(['big', 'small'])
  })

  it('counts the posts published inside the window and carries the best x-factor', () => {
    creator('jane')
    cap('jane', '2026-09-08', 20_000)
    cap('jane', '2026-09-09', 20_500)
    insertPosts([
      post('1', 'jane', '2026-09-09T08:00:00.000Z', 1.2),
      post('2', 'jane', '2026-09-09T12:00:00.000Z', 4.4),
      post('3', 'jane', '2026-08-01T12:00:00.000Z', 9.9), // outside the window
    ])

    const [jane] = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' }).absolute
    expect(jane).toMatchObject({ posts: 2, best_x_factor: 4.4 })
  })

  it('defaults asOf to the newest captured day so the board is never blank on a missed run', () => {
    creator('jane')
    cap('jane', '2026-09-07', 20_000)
    cap('jane', '2026-09-08', 20_400)

    const board = buildLeaderboard({ windowDays: 1 })
    expect(board.as_of).toBe('2026-09-08')
    expect(board.absolute[0]?.gained).toBe(400)
  })

  it('reports coverage so a half-captured day is visible rather than read as flat growth', () => {
    creator('jane')
    creator('bob')
    cap('jane', '2026-09-08', 20_000)
    cap('jane', '2026-09-09', 20_500)

    const board = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' })
    expect(board.coverage).toEqual({ creators: 2, measured: 1 })
  })

  it('carries a compact spark series per row so the board can draw a sparkline without N more calls', () => {
    creator('jane')
    cap('jane', '2026-09-07', 20_000)
    cap('jane', '2026-09-08', 20_200)
    cap('jane', '2026-09-09', 20_500)

    const [jane] = buildLeaderboard({ windowDays: 30, asOf: '2026-09-09' }).absolute
    expect(jane?.spark).toEqual([20_000, 20_200, 20_500])
  })

  it('gives an unmeasured creator an empty spark rather than a fake flat line', () => {
    creator('newbie')
    const [row] = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' }).absolute
    expect(row?.spark).toEqual([])
  })

  it('shows only the tracked subset — a research-only creator never reaches the board', () => {
    creator('tracked')
    creator('research-only', 'Research Only', false)
    cap('tracked', '2026-09-08', 20_000)
    cap('tracked', '2026-09-09', 20_500)

    const board = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' })
    expect(board.absolute.map((r) => r.author_id)).toEqual(['tracked'])
    expect(board.coverage.creators).toBe(1)
  })

  it('ignores creators from other platforms', () => {
    upsertCreator({ platform: 'twitter', profile_url: 'https://x.com/tweeter', author_id: 'tweeter' })
    const board = buildLeaderboard({ windowDays: 1, asOf: '2026-09-09' })
    expect(board.absolute).toEqual([])
  })

  it('returns an empty board rather than throwing when nothing has been captured yet', () => {
    creator('jane')
    const board = buildLeaderboard({ windowDays: 7 })
    expect(board.absolute).toHaveLength(1)
    expect(board.absolute[0]?.gained).toBeNull()
    expect(board.percent).toEqual([])
  })
})

describe('creatorGrowthDetail', () => {
  it('returns the sparkline series plus a per-day delta', () => {
    creator('jane')
    cap('jane', '2026-09-07', 20_000)
    cap('jane', '2026-09-08', 20_200)
    cap('jane', '2026-09-09', 20_500)

    const detail = creatorGrowthDetail('jane', { days: 30, asOf: '2026-09-09' })

    expect(detail.series.map((s) => s.followers)).toEqual([20_000, 20_200, 20_500])
    expect(detail.days.map((d) => d.gained)).toEqual([200, 300])
  })

  it('attributes a day to its single post and marks a multi-post day as shared', () => {
    creator('jane')
    cap('jane', '2026-09-07', 20_000)
    cap('jane', '2026-09-08', 20_200)
    cap('jane', '2026-09-09', 20_500)
    insertPosts([
      post('solo', 'jane', '2026-09-08T09:00:00.000Z', 2.1),
      post('a', 'jane', '2026-09-09T09:00:00.000Z', 1.1),
      post('b', 'jane', '2026-09-09T15:00:00.000Z', 3.3),
    ])

    const detail = creatorGrowthDetail('jane', { days: 30, asOf: '2026-09-09' })

    expect(detail.days[0]).toMatchObject({
      captured_on: '2026-09-08',
      gained: 200,
      post_count: 1,
      shared: false,
      attributable_post_id: 'solo',
    })
    expect(detail.days[1]).toMatchObject({ post_count: 2, shared: true, attributable_post_id: null })
  })

  it('keeps a no-post day in the series — growth without a post is real signal', () => {
    creator('jane')
    cap('jane', '2026-09-08', 20_000)
    cap('jane', '2026-09-09', 20_300)

    const detail = creatorGrowthDetail('jane', { days: 30, asOf: '2026-09-09' })
    expect(detail.days[0]).toMatchObject({ gained: 300, post_count: 0, attributable_post_id: null })
  })

  it('is empty, not an error, for a creator never captured', () => {
    creator('ghost')
    const detail = creatorGrowthDetail('ghost', { days: 30, asOf: '2026-09-09' })
    expect(detail).toMatchObject({ series: [], days: [] })
  })
})
