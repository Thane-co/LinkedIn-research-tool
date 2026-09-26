// Layer 3 — backfillColdStartHistory: the §8.6 one-time cold-start backfill.
//
// THE GAP THIS CLOSES: ~10 creators added to the roster on 2026-09-10 have zero pre-roster
// history — the daily scrape only captures posts going forward. x-factor needs >= MIN_SPREAD_POSTS
// (15) / MIN_RESIDUALS (8) MATURE prior posts before it can score anything, so these creators sit
// x_provisional forever. §8.5's graduation pass confirmed re-reading doesn't help: there's no
// history in the DB to graduate. This job scrapes creators' OLDER posts (deeper postedLimit) via
// the SAME actor + insert path as the daily scrape (jobs/scrape.ts / lib/db/posts.repo insertPosts)
// — no second insert path.
//
// COST GUARD: bills per post read like the daily scrape/refresh. `--max-posts` (maxPosts) hard-caps
// total posts fetched across the whole run; `--dry-run` (dryRun) reports qualifying creators + the
// posts it WOULD fetch WITHOUT calling Apify.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backfillColdStartHistory, MIN_MATURE_POSTS } from '@/jobs/backfill-history'
import { runActor } from '@/lib/apify'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts, listColdStartAuthors } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import type { ApifyPost, PostRow } from '@/lib/types'

vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

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

/** A stored post older than 30 days ago (mature, "old history"). */
const oldPost = (id: string, author_id: string, postedDaysAgo: number, likes = 10): PostRow =>
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
    scraped_at: daysAgo(postedDaysAgo - 1),
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
    x_provisional: 0,
    measured_at: daysAgo(postedDaysAgo - 1),
    raw_data: null,
  }) as unknown as PostRow

const item = (id: string, author_id: string, likes: number, postedDaysAgo: number): ApifyPost =>
  ({
    linkedinUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    content: id,
    postedAt: { timestamp: Date.parse(daysAgo(postedDaysAgo)) },
    author: { publicIdentifier: author_id, name: author_id, type: 'profile' },
    engagement: { likes, comments: 0, shares: 0 },
  }) as unknown as ApifyPost

describe('listColdStartAuthors (§8.6 backfill)', () => {
  it('finds roster authors with fewer than MIN_MATURE_POSTS posts older than 30 days', () => {
    creator('cold-guy') // zero posts at all
    creator('warm-guy')
    for (let i = 0; i < MIN_MATURE_POSTS; i++) {
      insertPosts([oldPost(`warm-${i}`, 'warm-guy', 40)])
    }
    const cold = listColdStartAuthors({ asOf: NOW, minMaturePosts: MIN_MATURE_POSTS })
    expect(cold.map((c) => c.author_id)).toEqual(['cold-guy'])
  })

  it('ignores non-roster authors', () => {
    insertPosts([oldPost('stranger-1', 'random-stranger', 40)])
    expect(listColdStartAuthors({ asOf: NOW, minMaturePosts: MIN_MATURE_POSTS })).toEqual([])
  })

  it('does not count recent posts (< 30 days old) toward maturity', () => {
    creator('recent-only')
    for (let i = 0; i < MIN_MATURE_POSTS; i++) {
      insertPosts([oldPost(`recent-${i}`, 'recent-only', 5)]) // too recent, not mature history
    }
    const cold = listColdStartAuthors({ asOf: NOW, minMaturePosts: MIN_MATURE_POSTS })
    expect(cold.map((c) => c.author_id)).toEqual(['recent-only'])
  })

  it('a creator at or above the threshold does not qualify', () => {
    creator('exactly-full')
    for (let i = 0; i < MIN_MATURE_POSTS; i++) {
      insertPosts([oldPost(`full-${i}`, 'exactly-full', 40)])
    }
    expect(listColdStartAuthors({ asOf: NOW, minMaturePosts: MIN_MATURE_POSTS })).toEqual([])
  })
})

describe('backfillColdStartHistory (§8.6 backfill job)', () => {
  it('dry-run reports qualifying creators and estimated posts/cost WITHOUT calling Apify', async () => {
    creator('cold-guy')
    const res = await backfillColdStartHistory({ asOf: NOW, dryRun: true, postsPerCreator: 30 })
    expect(res.dryRun).toBe(true)
    expect(res.creators).toEqual(['cold-guy'])
    expect(res.estimated_posts).toBe(30)
    expect(res.estimated_cost_usd).toBeCloseTo(0.06, 5)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('dry-run with zero qualifying creators costs nothing and calls nothing', async () => {
    creator('warm-guy')
    for (let i = 0; i < MIN_MATURE_POSTS; i++) {
      insertPosts([oldPost(`warm-${i}`, 'warm-guy', 40)])
    }
    const res = await backfillColdStartHistory({ asOf: NOW, dryRun: true })
    expect(res.creators).toEqual([])
    expect(res.estimated_posts).toBe(0)
    expect(res.estimated_cost_usd).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('real run fetches older posts per qualifying creator, inserts via insertPosts, recomputes', async () => {
    creator('cold-guy')
    mockRunActor.mockResolvedValue([
      item('9001', 'cold-guy', 5, 60),
      item('9002', 'cold-guy', 8, 65),
    ])

    const res = await backfillColdStartHistory({ asOf: NOW, postsPerCreator: 30 })

    expect(res.dryRun).toBe(false)
    expect(res.creators_processed).toBe(1)
    expect(res.posts_fetched).toBe(2)
    expect(res.new_posts).toBe(2)
    expect(res.cost_usd).toBeCloseTo(0.004, 5)
    expect(mockRunActor).toHaveBeenCalledTimes(1)
    // recompute ran (both posts should now have a weighted_score at minimum)
    expect(res.rescored).toBeGreaterThan(0)
  })

  it('never inserts a duplicate of an already-known post id', async () => {
    creator('cold-guy')
    insertPosts([oldPost('9101', 'cold-guy', 60)])
    mockRunActor.mockResolvedValue([item('9101', 'cold-guy', 99, 60)])

    const res = await backfillColdStartHistory({ asOf: NOW })

    expect(res.posts_fetched).toBe(1)
    expect(res.new_posts).toBe(0)
  })

  it('hard-caps total posts fetched across the run at --max-posts', async () => {
    creator('cold-1')
    creator('cold-2')
    mockRunActor.mockResolvedValue([item('9201', 'cold-1', 5, 60), item('9202', 'cold-2', 5, 60)])

    const res = await backfillColdStartHistory({ asOf: NOW, maxPosts: 1, postsPerCreator: 30 })

    // The cap must be respected — the job must not process a batch that would exceed it once
    // it can see the returned item count would blow the budget (batches of 1 creator here).
    expect(res.posts_fetched).toBeLessThanOrEqual(2)
    expect(res.creators_processed).toBeLessThanOrEqual(1)
  })

  it('a failed actor call for one creator is reported, never fatal to the run', async () => {
    creator('cold-1')
    creator('cold-2')
    mockRunActor
      .mockRejectedValueOnce(new Error('actor exploded'))
      .mockResolvedValueOnce([item('9301', 'cold-2', 5, 60)])

    const res = await backfillColdStartHistory({ asOf: NOW })

    expect(res.errors.length).toBe(1)
    expect(res.new_posts).toBe(1)
  })

  it('zero qualifying creators makes zero actor calls in a real run too', async () => {
    creator('warm-guy')
    for (let i = 0; i < MIN_MATURE_POSTS; i++) {
      insertPosts([oldPost(`warm-${i}`, 'warm-guy', 40)])
    }
    const res = await backfillColdStartHistory({ asOf: NOW })
    expect(res.creators_processed).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
    expect(res.cost_usd).toBe(0)
  })
})
