import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshRecentEngagement } from '@/jobs/refresh-engagement'
import { runActor } from '@/lib/apify'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { getPostSnapshots } from '@/lib/db/post-snapshots.repo'
import { getPostById, insertPosts } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import type { ApifyPost, PostRow } from '@/lib/types'

vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

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

const post = (id: string, author_id: string, posted_at: string, likes = 0): PostRow =>
  ({
    id, platform: 'linkedin', url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    content: id, author_name: author_id, author_url: null, author_id, author_type: 'profile',
    likes, shares: 0, comments: 0, posted_at, scraped_at: '2026-09-08T00:00:00.000Z',
    is_repost: 0, scrape_source: 'creator', market: 'ai', media: null, transcript: null,
    embedding: null, image_url: null, image_description: null, image_embedding: null,
    embedded_at: null, weighted_score: likes, creator_baseline: null, x_factor: null, raw_data: null,
  }) as unknown as PostRow

/** An Apify item shaped like the profile-posts actor's output for an existing post id. */
const item = (id: string, author_id: string, likes: number, comments = 0, shares = 0): ApifyPost =>
  ({
    linkedinUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    content: id,
    postedAt: { timestamp: Date.parse('2026-09-09T09:00:00.000Z') },
    author: { publicIdentifier: author_id, name: author_id, type: 'profile' },
    engagement: { likes, comments, shares },
  }) as unknown as ApifyPost

describe('refreshRecentEngagement (§22)', () => {
  it('records a snapshot for each returned post', async () => {
    creator('jane')
    insertPosts([post('111', 'jane', '2026-09-09T09:00:00.000Z', 10)])
    mockRunActor.mockResolvedValue([item('111', 'jane', 140, 12, 3)])

    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(res.snapshots).toBe(1)
    expect(getPostSnapshots('111')).toEqual([
      { captured_on: '2026-09-10', captured_at: '2026-09-10T06:00:00.000Z', likes: 140, comments: 12, shares: 3 },
    ])
  })

  it('updates the live post row too, so the dashboard shows current numbers', async () => {
    creator('jane')
    insertPosts([post('111', 'jane', '2026-09-09T09:00:00.000Z', 10)])
    mockRunActor.mockResolvedValue([item('111', 'jane', 140, 12, 3)])

    await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(getPostById('111')).toMatchObject({ likes: 140, comments: 12, shares: 3 })
  })

  it('inserts a post it has never seen before rather than dropping it', async () => {
    creator('jane')
    mockRunActor.mockResolvedValue([item('999', 'jane', 50)])

    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(res.new_posts).toBe(1)
    expect(getPostById('999')).toBeTruthy()
    expect(getPostSnapshots('999')).toHaveLength(1)
  })

  it('sends every creator in one batched actor run', async () => {
    creator('a')
    creator('b')
    mockRunActor.mockResolvedValue([])

    await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(mockRunActor).toHaveBeenCalledTimes(1)
    const [actorId, input] = mockRunActor.mock.calls[0]!
    expect(actorId).toBe('harvestapi/linkedin-profile-posts')
    expect((input as { targetUrls: string[] }).targetUrls).toHaveLength(2)
  })

  it('re-running the same day refreshes the snapshot instead of duplicating it', async () => {
    creator('jane')
    insertPosts([post('111', 'jane', '2026-09-09T09:00:00.000Z', 10)])
    mockRunActor.mockResolvedValue([item('111', 'jane', 100)])
    await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })
    mockRunActor.mockResolvedValue([item('111', 'jane', 175)])
    await refreshRecentEngagement({ asOf: '2026-09-10T21:00:00.000Z' })

    const series = getPostSnapshots('111')
    expect(series).toHaveLength(1)
    expect(series[0]?.likes).toBe(175)
  })

  it('a failed batch never aborts the run', async () => {
    for (const n of ['a', 'b', 'c', 'd']) creator(n)
    mockRunActor
      .mockRejectedValueOnce(new Error('actor 500'))
      .mockResolvedValueOnce([item('222', 'c', 20)])

    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z', batchSize: 2 })

    expect(res.snapshots).toBe(1)
    expect(res.errors).toHaveLength(1)
  })

  it('does nothing when no creator is on the roster', async () => {
    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })
    expect(res.creators).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('throws a clear error when no profile-posts actor is configured', async () => {
    setSettings({ apify_profile_actor_id: '' })
    creator('jane')
    await expect(refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })).rejects.toThrow(/actor/i)
  })

  it('reports the run cost so the spend is visible, not a surprise on the invoice', async () => {
    creator('jane')
    mockRunActor.mockResolvedValue([item('1', 'jane', 5), item('2', 'jane', 6), item('3', 'jane', 7)])

    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(res.posts_returned).toBe(3)
    expect(res.cost_usd).toBeCloseTo(3 * 0.002, 5)
  })
})
