import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/posts/route'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts } from '@/lib/db/posts.repo'
import { vectorToBlob } from '@/lib/pure/vector-blob'
import { makePostRow } from '@/tests/fixtures/posts'
import type { PostRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const seed = (rows: Partial<PostRow>[]): void => {
  insertPosts(rows.map((r) => makePostRow(r)))
}
const get = (qs = ''): Promise<Response> => GET(new Request(`http://localhost/api/posts${qs}`))

describe('GET /api/posts — paginated mode', () => {
  it('serializes a valid media object but nulls a valid-JSON wrong-shape one', async () => {
    seed([
      { id: 'good', media: JSON.stringify({ type: 'image', images: ['x'] }) },
      { id: 'bad', media: '{"type":"bogus"}' }, // parses, but not a PostMedia
    ])
    const body = await (await get()).json()
    const byId = Object.fromEntries(body.posts.map((p: { id: string; media: unknown }) => [p.id, p.media]))
    expect(byId.good).toEqual({ type: 'image', images: ['x'] })
    expect(byId.bad).toBeNull()
  })

  it('ignores an unknown timeframe param instead of crashing on an invalid date', async () => {
    seed([{ id: 'a', posted_at: '2020-01-01T00:00:00.000Z' }])
    const res = await get('?timeframe=quarter') // not a real Timeframe
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posts.map((p: { id: string }) => p.id)).toContain('a')
  })

  it('ignores an unknown platform filter rather than silently returning nothing', async () => {
    seed([{ id: 'a', platform: 'linkedin' }])
    const body = await (await get('?platform=myspace')).json()
    expect(body.posts.map((p: { id: string }) => p.id)).toContain('a')
  })

  it('filters by a platform subset (§17.4): platform=substack,linkedin', async () => {
    seed([
      { id: 'l', platform: 'linkedin' },
      { id: 't', platform: 'twitter' },
      { id: 's', platform: 'substack' },
    ])
    const body = await (await get('?platform=substack,linkedin')).json()
    expect(body.posts.map((p: { id: string }) => p.id).sort()).toEqual(['l', 's'])
    // availableAuthors always carries the persona field (null for non-creators)
    expect(body.availableAuthors.every((a: { persona?: unknown }) => 'persona' in a)).toBe(true)
  })

  it('applies filters and never serializes raw blobs/raw_data', async () => {
    seed([
      { id: 'a', platform: 'linkedin', content: 'ai agents', likes: 100, embedding: vectorToBlob([1, 0, 0, 0]) },
      { id: 'b', platform: 'twitter', content: 'gardening', likes: 5 },
    ])
    const body = await (await get('?platform=linkedin&minLikes=50')).json()
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual(['a'])
    expect(body.posts[0].embedding).toBeUndefined() // blob stripped
    expect(body.posts[0].raw_data).toBeUndefined()
  })

  it('filters by market bucket', async () => {
    seed([
      { id: 'a', market: 'ai' },
      { id: 'b', market: 'linkedin' },
    ])
    const body = await (await get('?market=ai')).json()
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual(['a'])
  })

  it('sorts, paginates, and computes hasMore exactly + returns availableAuthors', async () => {
    seed([
      { id: 'a', author_id: 'jane', author_name: 'Jane', likes: 5 },
      { id: 'b', author_id: 'joe', author_name: 'Joe', likes: 50 },
      { id: 'c', author_id: 'jane', author_name: 'Jane', likes: 20 },
    ])
    const p1 = await (await get('?sort=likes&page=1&pageSize=2')).json()
    expect(p1.posts.map((p: { id: string }) => p.id)).toEqual(['b', 'c'])
    expect(p1.total).toBe(3)
    expect(p1.hasMore).toBe(true)
    // availableAuthors is always present (distinct)
    expect(p1.availableAuthors.map((a: { author_id: string }) => a.author_id).sort()).toEqual(['jane', 'joe'])

    const p2 = await (await get('?sort=likes&page=2&pageSize=2')).json()
    expect(p2.hasMore).toBe(false)
  })
})

describe('GET /api/posts — grouping mode', () => {
  const timg = vectorToBlob([1, 0, 0, 0])
  const timg2 = vectorToBlob([0.99, 0.01, 0, 0])

  it('groupByImage returns image groups and full member posts (no per-card annotation)', async () => {
    seed([
      { id: 'g1', likes: 10, embedding: timg, image_embedding: timg, image_description: 'chart' },
      { id: 'g2', likes: 8, embedding: timg, image_embedding: timg2, image_description: 'chart' },
      { id: 'lonely', likes: 1, embedding: timg, image_embedding: vectorToBlob([0, 1, 0, 0]) },
    ])
    const body = await (await get('?groupByImage=true')).json()
    expect(body.hasMore).toBe(false)
    expect(body.imageGroups).toHaveLength(1)
    expect(body.imageGroups[0].postIds.sort()).toEqual(['g1', 'g2'])
    // members are returned as full renderable posts, looked up by id — no imageGroupSize badge
    const g1 = body.posts.find((p: { id: string }) => p.id === 'g1')
    expect(g1).toBeDefined()
    expect(g1.url).toBeDefined()
    expect(g1.imageGroupSize).toBeUndefined()
  })

  it('discoverTrends returns content clusters', async () => {
    seed([
      { id: 'c1', content: 'ai agents are the future', likes: 10, embedding: timg },
      { id: 'c2', content: 'the future of ai agents', likes: 8, embedding: timg2 },
      { id: 'c3', content: 'unrelated gardening', likes: 5, embedding: vectorToBlob([0, 1, 0, 0]) },
    ])
    const body = await (await get('?discoverTrends=true')).json()
    expect(body.contentClusters).toHaveLength(1)
    expect(body.contentClusters[0].postIds.sort()).toEqual(['c1', 'c2'])
  })

  it('respects the 400-candidate cap', async () => {
    seed(
      Array.from({ length: 401 }, (_, i) => ({
        id: `p${i}`,
        likes: i,
        embedding: timg,
        image_embedding: timg,
      })),
    )
    const body = await (await get('?groupByImage=true')).json()
    expect(body.posts.length).toBe(400)
  })
})
