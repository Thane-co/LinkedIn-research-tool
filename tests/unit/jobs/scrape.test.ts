import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeXFactors, runScrape } from '@/jobs/scrape'
import { runActor } from '@/lib/apify'
import { enrichPosts } from '@/jobs/enrich'
import { getDb, resetDb } from '@/lib/db/db'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getAuthorHistory, insertPosts, searchPosts } from '@/lib/db/posts.repo'
import { fetchSubstackNoteContent } from '@/lib/substack'
import { makePostRow } from '@/tests/fixtures/posts'
import type { ApifyInstagramPost, ApifyPost, ApifySubstackPost } from '@/lib/types'

// Keep the pure input builders real; mock only the network run (PRD §12 step 21) + the follow-on
// enrich (its own unit covers it — here we only assert it is/ isn't fired).
vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
vi.mock('@/jobs/enrich', () => ({
  enrichPosts: vi.fn().mockResolvedValue({ embedded: 0, remaining: 0 }),
}))
// The note backfill hits Substack's reader API — mock it (returns null by default = no backfill).
vi.mock('@/lib/substack', () => ({ fetchSubstackNoteContent: vi.fn().mockResolvedValue(null) }))

const mockRunActor = vi.mocked(runActor)
const mockEnrich = vi.mocked(enrichPosts)
const mockNoteBackfill = vi.mocked(fetchSubstackNoteContent)

/** Build a raw Apify LinkedIn item whose canonical id derives from the url (not raw.id). */
const liItem = (activityId: string, over: Partial<ApifyPost> = {}): ApifyPost => ({
  id: `feed-event-${activityId}`, // deliberately NOT the canonical id — mapper must use the url
  linkedinUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
  content: 'a post about ai agents',
  author: { name: 'Jane', universalName: 'jane', type: 'profile' },
  postedAt: { date: '2026-06-20T00:00:00.000Z' },
  engagement: { likes: 10, comments: 0, shares: 0 },
  ...over,
})

/** Build a raw Apify Substack item. */
const substackItem = (id: string, over: Partial<ApifySubstackPost> = {}): ApifySubstackPost => ({
  id,
  slug: `post-${id}`,
  url: `https://laraacosta.substack.com/p/post-${id}`,
  title: 'a substack post about ai agents',
  publishedAt: '2026-06-21T00:00:00.000Z',
  publicationHandle: 'laraacosta',
  publicationName: 'Lara Acosta',
  reactionCount: 50,
  ...over,
})

/** Build a raw Apify Instagram item. */
const instagramItem = (code: string, over: Partial<ApifyInstagramPost> = {}): ApifyInstagramPost => ({
  id: `id-${code}`,
  shortCode: code,
  url: `https://www.instagram.com/p/${code}/`,
  caption: 'a reel about ai agents',
  type: 'Video',
  likesCount: 100,
  commentsCount: 5,
  timestamp: '2026-06-22T00:00:00.000Z',
  ownerUsername: 'natgeo',
  ownerFullName: 'National Geographic',
  displayUrl: 'https://ig.cdn/poster.jpg',
  videoUrl: 'https://ig.cdn/reel.mp4',
  ...over,
})

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  mockEnrich.mockResolvedValue({ embedded: 0, remaining: 0 })
  mockNoteBackfill.mockResolvedValue(null) // default: no backfill (reset by clearAllMocks)
})
afterEach(() => resetDb())

describe('runScrape', () => {
  it('runs keyword + creator in parallel and reports duplicate/both counts', async () => {
    upsertCreator({
      platform: 'linkedin',
      profile_url: 'https://www.linkedin.com/in/jane',
      author_id: 'jane',
    })
    mockRunActor.mockImplementation(async (_actorId, input: object) => {
      if ('searchQueries' in input) return [liItem('100'), liItem('200')]
      if ('targetUrls' in input) return [liItem('100'), liItem('300')] // 100 overlaps keyword
      return []
    })

    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'both',
      keywords: ['ai agents'],
      timeframe: 'week',
      market: 'ai',
    })

    // both scrapers fired
    expect(mockRunActor).toHaveBeenCalledTimes(2)
    expect(stats).toEqual({
      keyword_raw: 2,
      creator_raw: 2,
      merged_total: 3, // 100, 200, 300
      duplicates: 1, // 100 seen twice
      found_in_both: 1, // 100 in keyword AND creator
      inserted: 3,
    })

    // job row persisted as succeeded with the same stats
    const job = searchPosts({}) // sanity: rows landed
    expect(job.total).toBe(3)
    expect(mockEnrich).toHaveBeenCalledTimes(1) // fired because inserted > 0
  })

  it('scrapes a Substack creator via the substack actor and maps its posts (§17.1)', async () => {
    upsertCreator({
      platform: 'substack',
      profile_url: 'https://laraacosta.substack.com',
      author_id: 'laraacosta',
    })
    let creatorInput: Record<string, unknown> | null = null
    mockRunActor.mockImplementation(async (_actorId, input: object) => {
      if ('publicationHandles' in input) {
        creatorInput = input as Record<string, unknown>
        return [substackItem('1'), substackItem('2')]
      }
      return []
    })

    const stats = await runScrape({
      platforms: ['substack'],
      mode: 'creator',
      timeframe: 'week',
      market: 'ai',
      includeNotes: true,
    })

    expect(creatorInput).not.toBeNull() // creator mode targets publications by handle
    expect(creatorInput!.publicationHandles).toEqual(['laraacosta']) // the creator's author_id, not its profile url
    expect(creatorInput!.userHandles).toEqual(['laraacosta']) // includeNotes threaded through → Notes feed requested
    // a bounded timeframe passes a dateFrom cutoff so we don't re-fetch (re-pay for) old posts
    expect(typeof creatorInput!.dateFrom).toBe('string')
    expect(stats.inserted).toBe(2)
    const rows = searchPosts({ platforms: ['substack'] }).posts
    expect(rows.map((p) => p.id).sort()).toEqual(['substack-1', 'substack-2'])
    expect(rows.every((p) => p.platform === 'substack')).toBe(true)
  })

  it('scrapes an Instagram creator via the instagram actor and maps its posts (§18)', async () => {
    upsertCreator({
      platform: 'instagram',
      profile_url: 'https://www.instagram.com/natgeo/',
      author_id: 'natgeo',
    })
    let creatorInput: Record<string, unknown> | null = null
    mockRunActor.mockImplementation(async (_actorId, input: object) => {
      if ('username' in input) {
        creatorInput = input as Record<string, unknown>
        return [instagramItem('AAA'), instagramItem('BBB')]
      }
      return []
    })

    const stats = await runScrape({ platforms: ['instagram'], mode: 'creator', timeframe: 'week', market: 'ai' })

    expect(creatorInput).not.toBeNull() // creator mode targets the profile url via `username`
    expect(creatorInput!.username).toEqual(['https://www.instagram.com/natgeo/'])
    expect(typeof creatorInput!.onlyPostsNewerThan).toBe('string') // bounded timeframe → date cutoff
    expect(stats.inserted).toBe(2)
    const rows = searchPosts({ platforms: ['instagram'] }).posts
    expect(rows.map((p) => p.id).sort()).toEqual(['instagram-AAA', 'instagram-BBB'])
    expect(rows.every((p) => p.platform === 'instagram')).toBe(true)
  })

  it('does NOT run Instagram in keyword-only mode (the post scraper is profile-driven) (§18)', async () => {
    upsertCreator({ platform: 'instagram', profile_url: 'https://www.instagram.com/natgeo/', author_id: 'natgeo' })
    mockRunActor.mockResolvedValue([])
    await runScrape({ platforms: ['instagram'], mode: 'keyword', keywords: ['ai'], timeframe: 'week', market: 'ai' })
    expect(mockRunActor).not.toHaveBeenCalled() // no keyword actor for Instagram → nothing to run
  })

  it('skips Substack author/publication metadata records (only posts + notes are stored) (§17)', async () => {
    upsertCreator({
      platform: 'substack',
      profile_url: 'https://laraacosta.substack.com',
      author_id: 'laraacosta',
    })
    mockRunActor.mockImplementation(async (_actorId, input: object) => {
      if ('publicationHandles' in input) {
        return [
          substackItem('1'), // a real post
          { type: 'author', id: 'auth-1', handle: 'laraacosta' } as unknown as ApifySubstackPost, // metadata
          { type: 'publication', id: 'pub-1' } as unknown as ApifySubstackPost, // metadata
          { type: 'note', id: 'note-1', authorHandle: 'laraacosta', body: 'a note', reactionCount: 3 } as unknown as ApifySubstackPost,
          { type: 'note', id: 'empty-1', authorHandle: 'laraacosta', body: '' } as unknown as ApifySubstackPost, // empty → skipped
        ]
      }
      return []
    })

    const stats = await runScrape({ platforms: ['substack'], mode: 'creator', timeframe: 'week', market: 'ai' })

    expect(stats.inserted).toBe(2) // the post + the note; the 2 metadata records are dropped
    const ids = searchPosts({ platforms: ['substack'] }).posts.map((p) => p.id).sort()
    expect(ids).toEqual(['substack-1', 'substack-note-note-1'])
  })

  it('backfills an empty post-share note from the reader API, dropping only the un-backfillable (§17)', async () => {
    upsertCreator({ platform: 'substack', profile_url: 'https://laraacosta.substack.com', author_id: 'laraacosta' })
    mockRunActor.mockImplementation(async (_a, input: object) => {
      if ('publicationHandles' in input) {
        return [
          { type: 'note', id: 'share-1', authorHandle: 'laraacosta', body: '' } as unknown as ApifySubstackPost, // empty → backfill succeeds
          { type: 'note', id: 'dead-1', authorHandle: 'laraacosta', body: '' } as unknown as ApifySubstackPost, // empty → backfill fails → dropped
        ]
      }
      return []
    })
    // First empty note backfills; second returns null (un-recoverable) and is dropped.
    mockNoteBackfill
      .mockResolvedValueOnce({ content: 'Shared: The 3x Templates', imageUrl: 'https://cdn/cover.png' })
      .mockResolvedValueOnce(null)

    const stats = await runScrape({ platforms: ['substack'], mode: 'creator', timeframe: 'week', market: 'ai' })

    expect(mockNoteBackfill).toHaveBeenCalledTimes(2) // both empties attempted
    expect(stats.inserted).toBe(1) // only the backfilled one survives
    const note = searchPosts({ platforms: ['substack'] }).posts[0]!
    expect(note.content).toBe('Shared: The 3x Templates')
    expect(note.image_url).toBe('https://cdn/cover.png')
    expect(note.url).toBe('https://substack.com/@laraacosta/note/c-share-1') // its own note url, not the article
  })

  it('runs LinkedIn + Substack together when both platforms are requested', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/in/jane', author_id: 'jane' })
    upsertCreator({ platform: 'substack', profile_url: 'https://laraacosta.substack.com', author_id: 'laraacosta' })
    mockRunActor.mockImplementation(async (_a, input: object) => {
      if ('targetUrls' in input) return [liItem('100')]
      if ('publicationHandles' in input) return [substackItem('1')]
      return []
    })

    const stats = await runScrape({
      platforms: ['linkedin', 'substack'],
      mode: 'creator',
      timeframe: 'week',
      market: 'ai',
    })

    expect(stats.inserted).toBe(2)
    expect(searchPosts({ platforms: ['substack'] }).total).toBe(1)
    expect(searchPosts({ platforms: ['linkedin'] }).total).toBe(1)
  })

  it('completes when one scraper returns nothing', async () => {
    upsertCreator({
      platform: 'linkedin',
      profile_url: 'https://www.linkedin.com/in/jane',
      author_id: 'jane',
    })
    mockRunActor.mockImplementation(async (_a, input: object) => {
      if ('searchQueries' in input) return [liItem('100')]
      return [] // creator empty
    })

    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'both',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })

    expect(stats.inserted).toBe(1)
    expect(stats.creator_raw).toBe(0)
  })

  it('marks the job failed when every scraper fails, and skips enrich', async () => {
    mockRunActor.mockRejectedValue(new Error('Apify down'))

    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'keyword',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })

    expect(stats.inserted).toBe(0)
    expect(mockEnrich).not.toHaveBeenCalled()

    const failed = getDb()
      .prepare("SELECT status, error FROM scrape_jobs WHERE status = 'failed'")
      .get() as { status: string; error: string } | undefined
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toMatch(/Apify down/)
  })

  it('skips a non-English post', async () => {
    mockRunActor.mockImplementation(async (_a, input: object) =>
      'searchQueries' in input
        ? [liItem('100', { content: 'これはテストです これはテストです' }), liItem('200')]
        : [],
    )
    const stats = await runScrape({
      platforms: ['linkedin'],
      mode: 'keyword',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })
    expect(stats.inserted).toBe(1) // only the English post 200
  })

  it('recomputes x-factor scoped to the authors it just inserted, leaving others untouched', async () => {
    // jane has 20 mature priors, each weighted 10 (likes=10), spaced 3 days apart inside the last
    // 60 days — enough for both the level (>=5) and spread (>=15) windows. All identical, so the level
    // is 10 raw points and the spread hits the floor. A new 900-point post then scores deterministically.
    const janePriors = Array.from({ length: 20 }, (_, i) =>
      makePostRow({
        id: `j${i}`,
        author_id: 'jane',
        posted_at: new Date(Date.parse('2026-06-24T00:00:00.000Z') - i * 3 * 86_400_000).toISOString(),
        scraped_at: '2026-06-28T00:00:00.000Z', // measured well after each posting -> mature
        likes: 10,
      }),
    )
    insertPosts([
      ...janePriors,
      // bob is NOT scraped this run -> must stay untouched (null score)
      makePostRow({ id: 'bob1', author_id: 'bob', posted_at: '2026-06-01T00:00:00.000Z', likes: 5 }),
    ])

    mockRunActor.mockImplementation(async (_a, input: object) =>
      'searchQueries' in input
        ? [liItem('900', { engagement: { likes: 900, comments: 0, shares: 0 }, postedAt: { date: '2026-06-25T00:00:00.000Z' } })]
        : [],
    )

    await runScrape({
      platforms: ['linkedin'],
      mode: 'keyword',
      keywords: ['ai'],
      timeframe: 'week',
      market: 'ai',
    })

    const jane = getAuthorHistory('jane')
    const fresh = jane.find((p) => p.id === '900')!
    expect(fresh.weighted_score).toBe(900)
    expect(fresh.creator_baseline).toBeCloseTo(10, 6) // level in raw points = exp(lg(10)) - 1
    expect(fresh.x_factor).toBeCloseTo(90, 4) // 900 / 10
    expect(fresh.x_score).not.toBeNull()
    expect(fresh.x_score!).toBeGreaterThan(2)
    expect(fresh.x_provisional).toBe(0) // posted 2026-06-25, measured months later -> mature

    const bob = getAuthorHistory('bob')[0]!
    expect(bob.weighted_score).toBeNull() // untouched — not in the affected set
    expect(bob.x_score).toBeNull()
  })
})

describe('recomputeXFactors', () => {
  /** N mature priors for one author, each weighted `weight`, spaced 3 days apart before `end`. */
  const maturePriors = (authorId: string, n: number, weight: number, end = '2026-06-24T00:00:00.000Z') =>
    Array.from({ length: n }, (_, i) =>
      makePostRow({
        id: `${authorId}-${i}`,
        author_id: authorId,
        author_url: `https://li/in/${authorId}?miniProfileUrn=${i}`, // deliberately-varying url
        posted_at: new Date(Date.parse(end) - i * 3 * 86_400_000).toISOString(),
        scraped_at: '2026-06-28T00:00:00.000Z',
        likes: weight,
      }),
    )

  it('groups an author by author_id even when author_url differs (miniProfileUrn query strings)', () => {
    insertPosts([
      ...maturePriors('jane', 20, 10),
      makePostRow({
        id: 'p4',
        author_id: 'jane',
        author_url: 'https://li/in/jane?miniProfileUrn=Z',
        posted_at: '2026-06-25T00:00:00.000Z',
        scraped_at: '2026-06-30T00:00:00.000Z',
        likes: 900,
      }),
    ])

    recomputeXFactors(['jane'])

    const p4 = searchPosts({}).posts.find((p) => p.id === 'p4')!
    // If it had matched on author_url the 20 priors wouldn't group and the score would be null.
    expect(p4.creator_baseline).toBeCloseTo(10, 6)
    expect(p4.x_factor).toBeCloseTo(90, 4)
    expect(p4.x_score).not.toBeNull()
  })

  it('writes weighted_score for every post of the affected author', () => {
    insertPosts([makePostRow({ id: 's1', author_id: 'sam', likes: 2, comments: 1, shares: 1 })])
    recomputeXFactors(['sam'])
    const s1 = searchPosts({}).posts.find((p) => p.id === 's1')!
    expect(s1.weighted_score).toBe(2 * 1 + 1 * 3 + 1 * 5) // = 10
  })

  it('dedupes the author list and is a no-op for an unknown author (non-fatal)', () => {
    expect(() => recomputeXFactors(['ghost', 'ghost', ''])).not.toThrow()
  })
})

describe('runScrape — Twitter likes floor (PRD §11.8)', () => {
  it('passes minimumFavorites through to the keyword input', async () => {
    mockRunActor.mockResolvedValue([])
    await runScrape({
      platforms: ['twitter'],
      mode: 'keyword',
      keywords: ['ai agents'],
      timeframe: 'week',
      market: 'ai',
      minimumFavorites: 250,
    })
    expect(mockRunActor.mock.calls[0]![1]).toMatchObject({ searchTerms: ['ai agents'], minimumFavorites: 250 })
  })

  it('omits the floor entirely when none is set', async () => {
    mockRunActor.mockResolvedValue([])
    await runScrape({ platforms: ['twitter'], mode: 'keyword', keywords: ['ai'], timeframe: 'week', market: 'ai' })
    expect('minimumFavorites' in (mockRunActor.mock.calls[0]![1] as object)).toBe(false)
  })

  it('never applies the floor to a CREATOR run — x-factor needs a creator’s weak posts too', async () => {
    upsertCreator({ platform: 'twitter', profile_url: 'https://x.com/jane', author_id: 'jane' })
    mockRunActor.mockResolvedValue([])
    await runScrape({
      platforms: ['twitter'],
      mode: 'creator',
      timeframe: 'week',
      market: 'ai',
      minimumFavorites: 250,
    })
    const input = mockRunActor.mock.calls[0]![1] as object
    expect('twitterHandles' in input).toBe(true)
    expect('minimumFavorites' in input).toBe(false)
  })
})
