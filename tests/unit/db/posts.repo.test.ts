import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import {
  countUnembedded,
  findExistingIds,
  findExistingUrls,
  getAuthorHistory,
  getAvailableAuthors,
  getCandidatesForClustering,
  getUnembedded,
  insertPosts,
  searchPosts,
  setEmbedding,
  updateXFactor,
} from '@/lib/db/posts.repo'
import { upsertCreator } from '@/lib/db/creators.repo'
import { vectorToBlob } from '@/lib/pure/vector-blob'
import { makePostRow } from '@/tests/fixtures/posts'
import type { PostRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const seed = (rows: Partial<PostRow>[]): void => {
  insertPosts(rows.map((r) => makePostRow(r)))
}

describe('insertPosts + existence lookups', () => {
  it('inserts new rows and reports the count', () => {
    const res = insertPosts([makePostRow({ id: 'a' }), makePostRow({ id: 'b' })])
    expect(res.inserted).toBe(2)
  })

  it('ignores a row whose id already exists (INSERT OR IGNORE)', () => {
    insertPosts([makePostRow({ id: 'a', url: 'u1' })])
    const res = insertPosts([makePostRow({ id: 'a', url: 'u-different' })])
    expect(res.inserted).toBe(0)
  })

  it('ignores a row whose url collides with the unique index', () => {
    insertPosts([makePostRow({ id: 'a', url: 'dup' })])
    const res = insertPosts([makePostRow({ id: 'b', url: 'dup' })])
    expect(res.inserted).toBe(0)
  })

  it('allows multiple rows with a null url (partial unique index)', () => {
    const res = insertPosts([
      makePostRow({ id: 'a', url: null }),
      makePostRow({ id: 'b', url: null }),
    ])
    expect(res.inserted).toBe(2)
  })

  it('findExistingIds / findExistingUrls return only the present ones', () => {
    seed([{ id: 'a', url: 'ua' }, { id: 'b', url: 'ub' }])
    expect(findExistingIds(['a', 'x', 'b'])).toEqual(new Set(['a', 'b']))
    expect(findExistingUrls(['ua', 'zzz'])).toEqual(new Set(['ua']))
  })
})

describe('searchPosts — filters', () => {
  it('filters by platform', () => {
    seed([
      { id: 'l', platform: 'linkedin' },
      { id: 't', platform: 'twitter' },
    ])
    expect(searchPosts({ platform: 'twitter' }).posts.map((p) => p.id)).toEqual(['t'])
    expect(searchPosts({ platform: 'all' }).total).toBe(2)
  })

  it('matches keywords against content case-insensitively (OR across terms)', () => {
    seed([
      { id: 'a', content: 'The future of AI agents' },
      { id: 'b', content: 'Gardening tips' },
      { id: 'c', content: 'Cloud infra at scale' },
    ])
    const ids = searchPosts({ keywords: ['ai', 'cloud'] }).posts.map((p) => p.id).sort()
    expect(ids).toEqual(['a', 'c'])
  })

  it('filters by author_id include-list', () => {
    seed([
      { id: 'a', author_id: 'jane' },
      { id: 'b', author_id: 'joe' },
    ])
    expect(searchPosts({ authors: ['jane'] }).posts.map((p) => p.id)).toEqual(['a'])
  })

  it('applies engagement floors (minLikes / minShares)', () => {
    seed([
      { id: 'a', likes: 100, shares: 10 },
      { id: 'b', likes: 5, shares: 10 },
      { id: 'c', likes: 100, shares: 0 },
    ])
    expect(searchPosts({ minLikes: 50, minShares: 5 }).posts.map((p) => p.id)).toEqual(['a'])
  })

  it('minXFactor filters and excludes null x_factor', () => {
    seed([
      { id: 'a', x_factor: 3 },
      { id: 'b', x_factor: 1 },
      { id: 'c', x_factor: null },
    ])
    expect(searchPosts({ minXFactor: 2 }).posts.map((p) => p.id)).toEqual(['a'])
  })

  it('filters by a preset timeframe (last 24h)', () => {
    seed([
      { id: 'fresh', posted_at: isoAgo(2 * HOUR) },
      { id: 'old', posted_at: isoAgo(3 * DAY) },
    ])
    expect(searchPosts({ timeframe: '24h' }).posts.map((p) => p.id)).toEqual(['fresh'])
  })

  it('filters by a custom date range', () => {
    seed([
      { id: 'in', posted_at: '2026-03-15T00:00:00.000Z' },
      { id: 'before', posted_at: '2026-01-01T00:00:00.000Z' },
      { id: 'after', posted_at: '2026-06-01T00:00:00.000Z' },
    ])
    const res = searchPosts({
      timeframe: 'custom',
      dateFrom: '2026-03-01T00:00:00.000Z',
      dateTo: '2026-04-01T00:00:00.000Z',
    })
    expect(res.posts.map((p) => p.id)).toEqual(['in'])
  })
})

describe('searchPosts — sort, pagination, hasMore', () => {
  it('defaults to recent (posted_at DESC)', () => {
    seed([
      { id: 'old', posted_at: '2026-01-01T00:00:00.000Z' },
      { id: 'new', posted_at: '2026-06-01T00:00:00.000Z' },
      { id: 'mid', posted_at: '2026-03-01T00:00:00.000Z' },
    ])
    expect(searchPosts({}).posts.map((p) => p.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts by likes DESC', () => {
    seed([
      { id: 'a', likes: 5 },
      { id: 'b', likes: 50 },
      { id: 'c', likes: 20 },
    ])
    expect(searchPosts({ sort: 'likes' }).posts.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by x_factor DESC with nulls last', () => {
    seed([
      { id: 'a', x_factor: 1.5 },
      { id: 'n', x_factor: null },
      { id: 'b', x_factor: 4 },
    ])
    expect(searchPosts({ sort: 'xfactor' }).posts.map((p) => p.id)).toEqual(['b', 'a', 'n'])
  })

  it('paginates and computes hasMore exactly', () => {
    seed(Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, likes: i })))
    const page1 = searchPosts({ sort: 'likes', page: 1, pageSize: 2 })
    expect(page1.posts).toHaveLength(2)
    expect(page1.total).toBe(5)
    expect(page1.hasMore).toBe(true)

    const page3 = searchPosts({ sort: 'likes', page: 3, pageSize: 2 })
    expect(page3.posts).toHaveLength(1)
    expect(page3.hasMore).toBe(false)
  })

  it('clamps pageSize to a max of 200', () => {
    const res = searchPosts({ pageSize: 9999 })
    expect(res.pageSize).toBe(200)
  })
})

describe('clustering candidates + author history', () => {
  const tvec = vectorToBlob([1, 0, 0, 0])
  const ivec = vectorToBlob([0, 1, 0, 0])

  it('returns only embedded posts and decodes the vectors', () => {
    seed([
      { id: 'emb', embedding: tvec, image_embedding: ivec, image_description: 'd' },
      { id: 'plain', embedding: null },
    ])
    const cands = getCandidatesForClustering({}, false)
    expect(cands.map((c) => c.id)).toEqual(['emb'])
    expect(cands[0]!.textEmbedding).toEqual([1, 0, 0, 0])
    expect(cands[0]!.imageEmbedding).toEqual([0, 1, 0, 0])
  })

  it('requires an image embedding when asked', () => {
    seed([
      { id: 'textonly', embedding: tvec, image_embedding: null },
      { id: 'both', embedding: tvec, image_embedding: ivec },
    ])
    expect(getCandidatesForClustering({}, true).map((c) => c.id)).toEqual(['both'])
  })

  it('getAvailableAuthors returns distinct authors with the creator avatar when known', () => {
    seed([
      { id: 'a', author_id: 'jane', author_name: 'Jane', platform: 'linkedin' },
      { id: 'b', author_id: 'jane', author_name: 'Jane', platform: 'linkedin' },
      { id: 'c', author_id: 'joe', author_name: 'Joe', platform: 'twitter' },
      { id: 'd', author_id: null, author_name: 'Anon' }, // null author excluded
    ])
    upsertCreator({
      platform: 'linkedin',
      profile_url: 'https://li/in/jane',
      author_id: 'jane',
      avatar_url: 'https://img/jane.png',
    })

    const authors = getAvailableAuthors({})
    expect(authors).toEqual([
      { author_id: 'jane', author_name: 'Jane', avatar: 'https://img/jane.png' },
      { author_id: 'joe', author_name: 'Joe', avatar: null },
    ])
  })

  it('getAvailableAuthors applies non-author filters but ignores the author include-list', () => {
    seed([
      { id: 'a', author_id: 'jane', author_name: 'Jane', platform: 'linkedin' },
      { id: 'c', author_id: 'joe', author_name: 'Joe', platform: 'twitter' },
    ])
    // platform filter narrows the list; the authors filter must NOT (so the dropdown stays full)
    const li = getAvailableAuthors({ platform: 'linkedin', authors: ['joe'] })
    expect(li.map((a) => a.author_id)).toEqual(['jane'])
  })

  it('getAuthorHistory returns the author rows ordered by posted_at', () => {
    seed([
      { id: 'a1', author_id: 'jane', posted_at: '2026-02-01T00:00:00.000Z' },
      { id: 'a2', author_id: 'jane', posted_at: '2026-01-01T00:00:00.000Z' },
      { id: 'z', author_id: 'joe', posted_at: '2026-01-01T00:00:00.000Z' },
    ])
    expect(getAuthorHistory('jane').map((p) => p.id)).toEqual(['a2', 'a1'])
  })
})

describe('x-factor + embedding writes', () => {
  it('updateXFactor writes the three score columns', () => {
    seed([{ id: 'a' }])
    updateXFactor('a', { weighted_score: 42, creator_baseline: 10, x_factor: 4.2 })
    const [row] = searchPosts({}).posts
    expect({ ws: row!.weighted_score, cb: row!.creator_baseline, xf: row!.x_factor }).toEqual({
      ws: 42,
      cb: 10,
      xf: 4.2,
    })
  })

  it('getUnembedded returns only rows with a null embedding, up to the limit', () => {
    seed([
      { id: 'a', embedding: null },
      { id: 'b', embedding: vectorToBlob([1, 0, 0, 0]) },
      { id: 'c', embedding: null },
    ])
    expect(getUnembedded(10).map((p) => p.id).sort()).toEqual(['a', 'c'])
    expect(getUnembedded(1)).toHaveLength(1)
  })

  it('getUnembedded with reEmbed includes already-embedded rows', () => {
    seed([
      { id: 'a', embedding: null },
      { id: 'b', embedding: vectorToBlob([1, 0, 0, 0]) },
    ])
    expect(getUnembedded(10, { reEmbed: true }).map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it('countUnembedded counts only rows with a null embedding', () => {
    seed([
      { id: 'a', embedding: null },
      { id: 'b', embedding: vectorToBlob([1, 0, 0, 0]) },
      { id: 'c', embedding: null },
    ])
    expect(countUnembedded()).toBe(2)
  })

  it('setEmbedding stores the text embedding and embedded_at', () => {
    seed([{ id: 'a', embedding: null }])
    setEmbedding('a', vectorToBlob([1, 2, 3, 4]), '2026-06-30T00:00:00.000Z')
    expect(getUnembedded(10)).toHaveLength(0)
  })

  it('setEmbedding can also store the image embedding + description', () => {
    seed([{ id: 'a', embedding: null }])
    setEmbedding(
      'a',
      vectorToBlob([1, 0, 0, 0]),
      '2026-06-30T00:00:00.000Z',
      vectorToBlob([0, 1, 0, 0]),
      'a chart',
    )
    const [cand] = getCandidatesForClustering({}, true)
    expect(cand!.imageEmbedding).toEqual([0, 1, 0, 0])
    expect(cand!.image_description).toBe('a chart')
  })
})
