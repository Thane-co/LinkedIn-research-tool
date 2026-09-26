import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { graduateStuckPosts } from '@/jobs/graduate-stuck'
import { runActor } from '@/lib/apify'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { recordPostSnapshots } from '@/lib/db/post-snapshots.repo'
import { getPostById, insertPosts, listStuckAuthors } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import type { ApifyPost, PostRow } from '@/lib/types'

vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

// A frozen "now" so age math is deterministic: posts below are placed relative to it.
const NOW = '2026-09-26T12:00:00.000Z'
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  setSettings({ apify_profile_actor_id: 'harvestapi/linkedin-profile-posts' })
})
afterEach(() => resetDb())

const creator = (author_id: string) =>
  upsertCreator({
    platform: 'linkedin',
    profile_url: `https://www.linkedin.com/in/${author_id}`,
    author_id,
    display_name: author_id,
  })

/** A stored post whose ONLY measurement happened `measuredAgeDays` after posting. */
const post = (
  id: string,
  author_id: string,
  postedDaysAgo: number,
  measuredAgeDays: number,
  likes = 10,
): PostRow =>
  ({
    id,
    platform: 'linkedin',
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    content: id,
    author_name: author_id,
    author_url: null,
    author_id,
    author_type: 'profile',
    likes,
    shares: 0,
    comments: 0,
    posted_at: daysAgo(postedDaysAgo),
    scraped_at: daysAgo(postedDaysAgo - measuredAgeDays),
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
    weighted_score: likes,
    creator_baseline: null,
    x_factor: null,
    x_score: null,
    creator_spread: null,
    x_provisional: 1,
    measured_at: daysAgo(postedDaysAgo - measuredAgeDays),
    raw_data: null,
  }) as unknown as PostRow

const item = (id: string, author_id: string, likes: number): ApifyPost =>
  ({
    linkedinUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    content: id,
    postedAt: { timestamp: Date.parse(daysAgo(5)) },
    author: { publicIdentifier: author_id, name: author_id, type: 'profile' },
    engagement: { likes, comments: 0, shares: 0 },
  }) as unknown as ApifyPost

describe('listStuckAuthors (§8 graduation)', () => {
  it('finds roster authors with mature-aged posts whose last measurement was immature', () => {
    creator('stuck-guy')
    creator('healthy-guy')
    // stuck: posted 10d ago, measured at age 1d, never again
    insertPosts([post('1001', 'stuck-guy', 10, 1)])
    // healthy: posted 10d ago, measured at age 5d (mature measurement)
    insertPosts([post('1002', 'healthy-guy', 10, 5)])
    const stuck = listStuckAuthors({ asOf: NOW, minAgeDays: 3, maxAgeDays: 30 })
    expect(stuck.map((s) => s.author_id)).toEqual(['stuck-guy'])
    expect(stuck[0]!.stuck_posts).toBe(1)
  })

  it('ignores non-roster authors (keyword strangers cannot graduate)', () => {
    insertPosts([post('2001', 'random-stranger', 10, 1)])
    expect(listStuckAuthors({ asOf: NOW, minAgeDays: 3, maxAgeDays: 30 })).toEqual([])
  })

  it('ignores posts older than the window (backfill cost guard)', () => {
    creator('old-guy')
    insertPosts([post('3001', 'old-guy', 90, 1)])
    expect(listStuckAuthors({ asOf: NOW, minAgeDays: 3, maxAgeDays: 30 })).toEqual([])
  })

  it('a later mature snapshot un-sticks the post', () => {
    creator('snap-guy')
    insertPosts([post('4001', 'snap-guy', 10, 1)])
    recordPostSnapshots([
      {
        post_id: '4001',
        captured_on: daysAgo(2).slice(0, 10),
        captured_at: daysAgo(2), // age 8d at capture -> mature measurement exists
        likes: 20,
        comments: 0,
        shares: 0,
      },
    ])
    expect(listStuckAuthors({ asOf: NOW, minAgeDays: 3, maxAgeDays: 30 })).toEqual([])
  })
})

describe('graduateStuckPosts (§8 graduation pass)', () => {
  it('re-reads stuck authors, snapshots their posts, and recomputes scores', async () => {
    creator('stuck-guy')
    insertPosts([post('5001', 'stuck-guy', 10, 1, 10)])
    mockRunActor.mockResolvedValue([item('5001', 'stuck-guy', 99)])

    const res = await graduateStuckPosts({ asOf: NOW })

    expect(res.authors).toBe(1)
    expect(res.snapshots).toBeGreaterThanOrEqual(1)
    // engagement refreshed in place
    expect(getPostById('5001')?.likes).toBe(99)
    // the new snapshot is a mature measurement (age 10d) -> author no longer stuck
    expect(listStuckAuthors({ asOf: NOW, minAgeDays: 3, maxAgeDays: 30 })).toEqual([])
  })

  it('caps authors per run (cost guard) and reports the remainder', async () => {
    for (let i = 0; i < 5; i++) {
      creator(`stuck-${i}`)
      insertPosts([post(`60${i}0`, `stuck-${i}`, 10, 1)])
    }
    mockRunActor.mockResolvedValue([])
    const res = await graduateStuckPosts({ asOf: NOW, maxAuthors: 2 })
    expect(res.authors).toBe(2)
    expect(res.remaining_authors).toBe(3)
    expect(mockRunActor).toHaveBeenCalledTimes(1) // both fit one batch
  })

  it('a failed batch is reported, never fatal', async () => {
    creator('stuck-guy')
    insertPosts([post('7001', 'stuck-guy', 10, 1)])
    mockRunActor.mockRejectedValue(new Error('actor exploded'))
    const res = await graduateStuckPosts({ asOf: NOW })
    expect(res.errors.length).toBe(1)
    expect(res.snapshots).toBe(0)
  })

  it('no stuck authors -> zero actor calls, zero cost', async () => {
    creator('healthy-guy')
    insertPosts([post('8001', 'healthy-guy', 10, 5)])
    const res = await graduateStuckPosts({ asOf: NOW })
    expect(res.authors).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
    expect(res.cost_usd).toBe(0)
  })
})
