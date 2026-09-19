import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshRecentEngagement } from '@/jobs/refresh-engagement'
import * as scrapeJob from '@/jobs/scrape'
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
    embedded_at: null, weighted_score: likes, creator_baseline: null, x_factor: null,
    x_score: null, creator_spread: null, x_provisional: 0, measured_at: null, raw_data: null,
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

  it('recomputes x-factor after the refresh so a post whose counts changed gets a new x_score', async () => {
    creator('jane')
    // 20 mature priors (each weighted 10) + the post that will be refreshed. All measured months ago,
    // so they are mature and the target post can score once its engagement climbs.
    const priors = Array.from({ length: 20 }, (_, i) =>
      post(`p${i}`, 'jane', new Date(Date.parse('2026-06-24T00:00:00.000Z') - i * 3 * 86_400_000).toISOString(), 10),
    )
    insertPosts([
      ...priors,
      post('111', 'jane', '2026-06-25T00:00:00.000Z', 10),
    ])
    // The refresh returns a much bigger number for post 111 than it had before.
    mockRunActor.mockResolvedValue([item('111', 'jane', 900, 0, 0)])

    const before = getPostById('111')!
    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(res.rescored).toBeGreaterThan(0)
    const after = getPostById('111')!
    expect(after.likes).toBe(900) // counts refreshed
    expect(after.weighted_score).toBe(900)
    expect(after.x_score).not.toBeNull()
    // The stale score before the fix would have stayed put; it must reflect the new counts.
    expect(after.x_score).not.toBe(before.x_score)
    expect(after.creator_baseline).toBeCloseTo(10, 6) // level in raw points
  })

  it('scopes the recompute to the authors touched this run', async () => {
    creator('jane')
    creator('joe')
    // joe has a stored post but is NOT returned by this run -> his scores must stay null.
    insertPosts([post('joe1', 'joe', '2026-06-01T00:00:00.000Z', 5)])
    mockRunActor.mockImplementation(async (_a, input) =>
      (input as { targetUrls: string[] }).targetUrls.some((u) => u.includes('jane'))
        ? [item('5551', 'jane', 40)]
        : [],
    )

    await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z', batchSize: 1 })

    // jane's returned post got a weighted_score written; joe's untouched post keeps its seed
    // weighted_score and was never rescored (measured_at stays null — recompute writes it).
    expect(getPostById('5551')!.weighted_score).toBe(40)
    expect(getPostById('joe1')!.measured_at).toBeNull()
  })

  it('a recompute failure does not fail the job or lose the day snapshots', async () => {
    creator('jane')
    insertPosts([post('111', 'jane', '2026-09-09T09:00:00.000Z', 10)])
    mockRunActor.mockResolvedValue([item('111', 'jane', 140)])

    // Force the recompute to throw AFTER snapshots are recorded.
    const spy = vi.spyOn(scrapeJob, 'recomputeXFactors').mockImplementation(() => {
      throw new Error('recompute boom')
    })

    const res = await refreshRecentEngagement({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(res.snapshots).toBe(1) // the day's snapshot survived
    expect(res.errors.some((e) => /recompute/.test(e))).toBe(true)
    expect(getPostSnapshots('111')).toHaveLength(1)
    spy.mockRestore()
  })
})
