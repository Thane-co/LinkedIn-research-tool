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

  it('groupByImage returns image groups + annotates posts with imageGroupSize', async () => {
    seed([
      { id: 'g1', likes: 10, embedding: timg, image_embedding: timg, image_description: 'chart' },
      { id: 'g2', likes: 8, embedding: timg, image_embedding: timg2, image_description: 'chart' },
      { id: 'lonely', likes: 1, embedding: timg, image_embedding: vectorToBlob([0, 1, 0, 0]) },
    ])
    const body = await (await get('?groupByImage=true')).json()
    expect(body.hasMore).toBe(false)
    expect(body.imageGroups).toHaveLength(1)
    expect(body.imageGroups[0].postIds.sort()).toEqual(['g1', 'g2'])
    const g1 = body.posts.find((p: { id: string }) => p.id === 'g1')
    expect(g1.imageGroupSize).toBe(2)
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
