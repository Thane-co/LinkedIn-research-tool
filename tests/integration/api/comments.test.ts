import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/comments/scrape/route'
import { GET } from '@/app/api/posts/[id]/comments/route'
import { NotOwnPostError, scrapeOwnPostComments, type CommentScrapeResult } from '@/jobs/scrape-comments'
import { upsertComments } from '@/lib/db/comments.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import { makeCommentRow } from '@/tests/fixtures/comments'
import { makePostRow } from '@/tests/fixtures/posts'

vi.mock('@/jobs/scrape-comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/scrape-comments')>()
  return { ...actual, scrapeOwnPostComments: vi.fn() }
})
const mockScrape = vi.mocked(scrapeOwnPostComments)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
})
afterEach(() => resetDb())

const REPORT: CommentScrapeResult = {
  posts_considered: 1, posts_scraped: 1, up_to_date: 0, comments_returned: 309,
  stored: 309, dropped: 0, cost_usd: 0.618, errors: [],
}

describe('POST /api/comments/scrape', () => {
  const post = (body: unknown = {}, origin?: string): Request =>
    new Request('http://localhost/api/comments/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    })
  const ready = (): void => setSettings({ apify_api_token: 'tok', own_linkedin_author_id: 'basiakubicka' })

  it('refuses a cross-origin request with 403', async () => {
    expect((await POST(post({}, 'https://evil.example.com'))).status).toBe(403)
  })

  it('412s when the Apify token or her author id is missing', async () => {
    const noToken = await POST(post())
    expect(noToken.status).toBe(412)
    expect((await noToken.json()).needs).toEqual(['apify_api_token', 'own_linkedin_author_id'])

    setSettings({ apify_api_token: 'tok' })
    expect((await (await POST(post())).json()).needs).toEqual(['own_linkedin_author_id'])
    expect(mockScrape).not.toHaveBeenCalled()
  })

  it('400s a malformed body instead of guessing', async () => {
    ready()
    expect((await POST(post({ postIds: '100' }))).status).toBe(400)
    expect((await POST(post({ postIds: [100] }))).status).toBe(400)
    expect((await POST(post({ days: 0 }))).status).toBe(400)
    expect((await POST(post({ force: 'yes' }))).status).toBe(400)
    expect(mockScrape).not.toHaveBeenCalled()
  })

  it('runs the scrape with the requested scope and returns its report including the cost', async () => {
    ready()
    mockScrape.mockResolvedValue(REPORT)
    const res = await POST(post({ postIds: ['100'], force: true }))
    expect(res.status).toBe(200)
    expect(mockScrape).toHaveBeenCalledWith({ postIds: ['100'], force: true })
    expect(await res.json()).toMatchObject({ stored: 309, cost_usd: 0.618 })
  })

  it('treats an empty body as "my recent posts"', async () => {
    ready()
    mockScrape.mockResolvedValue(REPORT)
    const res = await POST(
      new Request('http://localhost/api/comments/scrape', { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    expect(mockScrape).toHaveBeenCalledWith({})
  })

  it("403s a request for someone else's post, naming the refused ids", async () => {
    ready()
    mockScrape.mockRejectedValue(new NotOwnPostError(['200']))
    const res = await POST(post({ postIds: ['200'] }))
    expect(res.status).toBe(403)
    expect((await res.json()).refused).toEqual(['200'])
  })

  it('502s when the scrape throws', async () => {
    ready()
    mockScrape.mockRejectedValue(new Error('no actor configured'))
    expect((await POST(post())).status).toBe(502)
  })
})

describe('GET /api/posts/[id]/comments', () => {
  const get = (id: string) => GET(new Request(`http://localhost/api/posts/${id}/comments`), { params: { id } })

  it('returns the stored comments for a post, oldest first, without the raw payload', async () => {
    insertPosts([makePostRow({ id: '100', comments: 2 })])
    upsertComments([
      makeCommentRow({ id: 'b', commented_at: '2026-09-14T12:00:00.000Z' }),
      makeCommentRow({ id: 'a', commented_at: '2026-09-14T09:00:00.000Z' }),
    ])
    const res = await get('100')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ post_id: '100', total_on_linkedin: 2 })
    expect(body.comments.map((c: { id: string }) => c.id)).toEqual(['a', 'b'])
    expect(body.comments[0]).not.toHaveProperty('raw_data')
  })

  it('is an empty list, not an error, for a post whose comments were never scraped', async () => {
    insertPosts([makePostRow({ id: '100' })])
    expect(await (await get('100')).json()).toMatchObject({ comments: [] })
  })

  it('404s an unknown post', async () => {
    expect((await get('nope')).status).toBe(404)
  })
})
