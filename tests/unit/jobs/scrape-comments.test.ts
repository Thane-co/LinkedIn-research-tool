import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotOwnPostError, scrapeOwnPostComments } from '@/jobs/scrape-comments'
import { runActor } from '@/lib/apify'
import { getCommentsForPost } from '@/lib/db/comments.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import { makePostRow } from '@/tests/fixtures/posts'
import type { ApifyComment } from '@/lib/types'

vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

const OWN = 'basiakubicka'
const NOW = '2026-09-15T12:00:00.000Z'

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  setSettings({ own_linkedin_author_id: OWN, apify_comments_actor_id: 'harvestapi/linkedin-post-comments' })
})
afterEach(() => resetDb())

const post = (id: string, author_id: string, comments: number, posted_at = '2026-09-13T13:00:00.000Z') =>
  makePostRow({ id, author_id, comments, posted_at })

const comment = (postId: string, id: string): ApifyComment => ({
  id,
  linkedinUrl:
    `https://www.linkedin.com/feed/update/urn:li:activity:${postId}` +
    `?commentUrn=${encodeURIComponent(`urn:li:comment:(activity:${postId},${id})`)}`,
  commentary: `comment ${id}`,
  createdAt: '2026-09-14T10:00:00.000Z',
  postId: `urn:li:activity:${postId}`,
  actor: { name: 'Jane', universalName: 'jane', author: false },
})

/** The post urls sent to the actor on the Nth run. */
const requested = (call = 0): string[] => (mockRunActor.mock.calls[call]![1] as { posts: string[] }).posts

describe('scrapeOwnPostComments (§23)', () => {
  it('stores every comment on her recent posts against the post it belongs to', async () => {
    insertPosts([post('100', OWN, 2)])
    mockRunActor.mockResolvedValue([comment('100', 'a'), comment('100', 'b')])

    const res = await scrapeOwnPostComments({ now: NOW })

    expect(mockRunActor.mock.calls[0]![0]).toBe('harvestapi/linkedin-post-comments')
    expect(requested()).toEqual(['https://www.linkedin.com/feed/update/urn:li:activity:100/'])
    expect(getCommentsForPost('100').map((c) => c.id)).toEqual(['a', 'b'])
    expect(res).toMatchObject({ posts_scraped: 1, comments_returned: 2, stored: 2 })
  })

  it("never sends another creator's post to the actor, even when it sits in the window", async () => {
    insertPosts([post('100', OWN, 2), post('200', 'someone-else', 90)])
    mockRunActor.mockResolvedValue([])

    await scrapeOwnPostComments({ now: NOW })

    expect(requested()).toEqual(['https://www.linkedin.com/feed/update/urn:li:activity:100/'])
  })

  it("refuses an explicit request for someone else's post before spending anything", async () => {
    insertPosts([post('100', OWN, 2), post('200', 'someone-else', 90)])

    await expect(scrapeOwnPostComments({ postIds: ['100', '200'], now: NOW })).rejects.toBeInstanceOf(NotOwnPostError)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('refuses a post id it has never stored — ownership cannot be checked', async () => {
    const err = await scrapeOwnPostComments({ postIds: ['999'], now: NOW }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotOwnPostError)
    expect((err as NotOwnPostError).postIds).toEqual(['999'])
  })

  it('an explicit post id is scraped even when it is older than the window', async () => {
    insertPosts([post('100', OWN, 1, '2025-01-01T00:00:00.000Z')])
    mockRunActor.mockResolvedValue([comment('100', 'a')])

    await scrapeOwnPostComments({ postIds: ['100'], now: NOW })

    expect(getCommentsForPost('100')).toHaveLength(1)
  })

  it('leaves out her posts older than the window', async () => {
    insertPosts([post('100', OWN, 2), post('101', OWN, 2, '2026-07-01T00:00:00.000Z')])
    mockRunActor.mockResolvedValue([])

    const res = await scrapeOwnPostComments({ now: NOW, days: 30 })

    expect(requested()).toEqual(['https://www.linkedin.com/feed/update/urn:li:activity:100/'])
    expect(res.posts_considered).toBe(1)
  })

  it('skips a post whose comments are already all stored, so a re-run costs nothing', async () => {
    insertPosts([post('100', OWN, 2)])
    mockRunActor.mockResolvedValue([comment('100', 'a'), comment('100', 'b')])
    await scrapeOwnPostComments({ now: NOW })

    const res = await scrapeOwnPostComments({ now: NOW })

    expect(mockRunActor).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ posts_scraped: 0, up_to_date: 1, cost_usd: 0 })
  })

  it('force re-reads an up-to-date post', async () => {
    insertPosts([post('100', OWN, 1)])
    mockRunActor.mockResolvedValue([comment('100', 'a')])
    await scrapeOwnPostComments({ now: NOW })

    await scrapeOwnPostComments({ postIds: ['100'], force: true, now: NOW })

    expect(mockRunActor).toHaveBeenCalledTimes(2)
  })

  it('stores the replies the actor nests inside a comment, linked to that comment', async () => {
    insertPosts([post('100', OWN, 2)])
    // Real LinkedIn comment ids are numeric, and the urn parser only accepts digits.
    const parent = comment('100', '7001')
    const reply: ApifyComment = {
      ...comment('100', '7002'),
      linkedinUrl:
        `https://www.linkedin.com/feed/update/urn:li:activity:100` +
        `?commentUrn=${encodeURIComponent('urn:li:comment:(activity:100,7001)')}` +
        `&replyUrn=${encodeURIComponent('urn:li:comment:(activity:100,7002)')}`,
      actor: { name: 'Basia Kubicka', universalName: OWN, author: true },
    }
    mockRunActor.mockResolvedValue([{ ...parent, replies: [reply] }])

    const res = await scrapeOwnPostComments({ now: NOW })

    const rows = getCommentsForPost('100')
    expect(rows.map((c) => c.id).sort()).toEqual(['7001', '7002'])
    expect(rows.find((c) => c.id === '7002')).toMatchObject({ parent_comment_id: '7001', is_post_author: 1 })
    expect(res).toMatchObject({ comments_returned: 1, stored: 2 })
  })

  it('drops a returned comment that belongs to a post it did not ask for', async () => {
    insertPosts([post('100', OWN, 1), post('200', 'someone-else', 5)])
    mockRunActor.mockResolvedValue([comment('100', 'a'), comment('200', 'stray')])

    const res = await scrapeOwnPostComments({ now: NOW })

    expect(getCommentsForPost('200')).toEqual([])
    expect(res).toMatchObject({ stored: 1, dropped: 1 })
  })

  it('skips an unmappable item loudly rather than failing the batch', async () => {
    insertPosts([post('100', OWN, 1)])
    const broken = { commentary: 'no ids at all' } as ApifyComment
    mockRunActor.mockResolvedValue([broken, comment('100', 'a')])

    const res = await scrapeOwnPostComments({ now: NOW })

    expect(res).toMatchObject({ stored: 1, dropped: 1 })
  })

  it('a failed batch never aborts the run', async () => {
    insertPosts([post('100', OWN, 1), post('101', OWN, 1)])
    mockRunActor.mockRejectedValueOnce(new Error('actor 500')).mockResolvedValueOnce([comment('101', 'a')])

    const res = await scrapeOwnPostComments({ now: NOW, batchSize: 1 })

    expect(res.stored).toBe(1)
    expect(res.errors).toHaveLength(1)
  })

  it('reports the run cost so the spend is visible', async () => {
    insertPosts([post('100', OWN, 3)])
    mockRunActor.mockResolvedValue([comment('100', 'a'), comment('100', 'b'), comment('100', 'c')])

    const res = await scrapeOwnPostComments({ now: NOW })

    expect(res.cost_usd).toBeCloseTo(3 * 0.002, 5)
  })

  it('throws a clear error when her author id is not configured', async () => {
    setSettings({ own_linkedin_author_id: '' })
    await expect(scrapeOwnPostComments({ now: NOW })).rejects.toThrow(/own_linkedin_author_id/)
  })

  it('throws a clear error when no comments actor is configured', async () => {
    setSettings({ apify_comments_actor_id: '' })
    await expect(scrapeOwnPostComments({ now: NOW })).rejects.toThrow(/apify_comments_actor_id/)
  })
})
