import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import {
  countUnembedded,
  findExistingIds,
  findExistingUrls,
  getAuthorHistory,
  getAvailableAuthors,
  getCandidatesForClustering,
  getCorpusStats,
  getPostById,
  getRecentViralLinkedIn,
  getUnembedded,
  getVideoPostsMissingTranscript,
  insertPosts,
  refreshEngagement,
  searchPosts,
  setEmbedding,
  setTranscript,
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

describe('refreshEngagement', () => {
  it('updates an existing row engagement numbers by id', () => {
    seed([{ id: 'a', likes: 10, shares: 1, comments: 2 }])
    const res = refreshEngagement([{ id: 'a', likes: 812, shares: 12, comments: 44 }])
    expect(res.updated).toBe(1)
    const [row] = searchPosts({}).posts
    expect({ likes: row!.likes, shares: row!.shares, comments: row!.comments }).toEqual({
      likes: 812,
      shares: 12,
      comments: 44,
    })
  })

  it('no-ops for an unknown id: does not throw and does not insert', () => {
    seed([{ id: 'a', likes: 5 }])
    const res = refreshEngagement([{ id: 'ghost', likes: 999, shares: 9, comments: 9 }])
    expect(res.updated).toBe(0)
    expect(searchPosts({}).total).toBe(1) // no new row inserted
    expect(getPostById('ghost')).toBeNull()
  })

  it('a batch updates only the ids given, leaving the rest untouched', () => {
    seed([
      { id: 'a', likes: 1, shares: 1, comments: 1 },
      { id: 'b', likes: 2, shares: 2, comments: 2 },
      { id: 'c', likes: 3, shares: 3, comments: 3 },
    ])
    const res = refreshEngagement([
      { id: 'a', likes: 100, shares: 10, comments: 5 },
      { id: 'c', likes: 300, shares: 30, comments: 15 },
    ])
    expect(res.updated).toBe(2)
    const byId = Object.fromEntries(searchPosts({}).posts.map((p) => [p.id, p.likes]))
    expect(byId).toEqual({ a: 100, b: 2, c: 300 })
  })
})

describe('getRecentViralLinkedIn', () => {
  it('returns recent LinkedIn posts, best x_factor first then likes, nulls last', () => {
    const since = isoAgo(72 * HOUR)
    seed([
      { id: 'top', platform: 'linkedin', posted_at: isoAgo(1 * HOUR), x_factor: 4, likes: 100 },
      { id: 'mid', platform: 'linkedin', posted_at: isoAgo(2 * HOUR), x_factor: 2, likes: 900 },
      { id: 'nullhi', platform: 'linkedin', posted_at: isoAgo(3 * HOUR), x_factor: null, likes: 500 },
      { id: 'nulllo', platform: 'linkedin', posted_at: isoAgo(4 * HOUR), x_factor: null, likes: 50 },
      { id: 'old', platform: 'linkedin', posted_at: isoAgo(5 * DAY), x_factor: 9, likes: 9 }, // outside 72h
      { id: 'tw', platform: 'twitter', posted_at: isoAgo(1 * HOUR), x_factor: 9, likes: 9 }, // wrong platform
    ])
    expect(getRecentViralLinkedIn(since).map((p) => p.id)).toEqual(['top', 'mid', 'nullhi', 'nulllo'])
  })

  it('breaks x_factor ties by likes DESC', () => {
    const since = isoAgo(72 * HOUR)
    seed([
      { id: 'a', platform: 'linkedin', posted_at: isoAgo(1 * HOUR), x_factor: 3, likes: 10 },
      { id: 'b', platform: 'linkedin', posted_at: isoAgo(2 * HOUR), x_factor: 3, likes: 90 },
    ])
    expect(getRecentViralLinkedIn(since).map((p) => p.id)).toEqual(['b', 'a'])
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

  it('filters by a platform subset (§17.4): platform IN (…)', () => {
    seed([
      { id: 'l', platform: 'linkedin' },
      { id: 't', platform: 'twitter' },
      { id: 's', platform: 'substack' },
    ])
    // "Substack + LinkedIn" but not Twitter
    expect(searchPosts({ platforms: ['substack', 'linkedin'] }).posts.map((p) => p.id).sort()).toEqual(['l', 's'])
    // a single-element subset behaves like the old single filter
    expect(searchPosts({ platforms: ['substack'] }).posts.map((p) => p.id)).toEqual(['s'])
    // an empty subset applies no platform filter (all)
    expect(searchPosts({ platforms: [] }).total).toBe(3)
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

  it('filters by market bucket', () => {
    seed([
      { id: 'a', market: 'ai' },
      { id: 'b', market: 'linkedin' },
    ])
    expect(searchPosts({ market: 'ai' }).posts.map((p) => p.id)).toEqual(['a'])
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
      { author_id: 'jane', author_name: 'Jane', platform: 'linkedin', avatar: 'https://img/jane.png', isCore: true, persona: null },
      { author_id: 'joe', author_name: 'Joe', platform: 'twitter', avatar: null, isCore: false, persona: null },
    ])
  })

  it('getAvailableAuthors collapses handle/display-name variants of one account into a single row', () => {
    // The same account accrues posts under both its real name and its bare handle; the dropdown must
    // show ONE row, preferring the human-looking name (has a space or capital) over the handle.
    seed([
      { id: 'a', author_id: 'aliciateltz', author_name: 'aliciateltz', platform: 'substack' },
      { id: 'b', author_id: 'aliciateltz', author_name: 'aliciateltz', platform: 'substack' },
      { id: 'c', author_id: 'aliciateltz', author_name: 'Alicia Teltz', platform: 'substack' },
    ])
    const authors = getAvailableAuthors({})
    expect(authors).toEqual([
      { author_id: 'aliciateltz', author_name: 'Alicia Teltz', platform: 'substack', avatar: null, isCore: false, persona: null },
    ])
  })

  it('getAvailableAuthors carries the creator persona so the dropdown can group by person (§17.3)', () => {
    seed([
      { id: 'a', author_id: 'lara-li', author_name: 'Lara Acosta', platform: 'linkedin' },
      { id: 'b', author_id: 'laraacosta', author_name: 'Lara Acosta', platform: 'substack' },
    ])
    upsertCreator({ platform: 'linkedin', profile_url: 'https://li/in/lara', author_id: 'lara-li', persona: 'lara acosta' })
    upsertCreator({ platform: 'substack', profile_url: 'https://laraacosta.substack.com', author_id: 'laraacosta', persona: 'lara acosta' })

    const byId = Object.fromEntries(getAvailableAuthors({}).map((a) => [a.author_id, a.persona]))
    expect(byId['lara-li']).toBe('lara acosta')
    expect(byId['laraacosta']).toBe('lara acosta') // both accounts share the persona
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

  it('getUnembedded also returns posts that have a thumbnail but no image embedding (backfill)', () => {
    const tvec = vectorToBlob([1, 0, 0, 0])
    const ivec = vectorToBlob([0, 1, 0, 0])
    seed([
      { id: 'textonly', embedding: tvec, image_url: null, image_embedding: null }, // done — no media
      { id: 'both', embedding: tvec, image_url: 'u', image_embedding: ivec }, // done — fully embedded
      { id: 'needimg', embedding: tvec, image_url: 'u', image_embedding: null }, // backfill the image
      { id: 'needtext', embedding: null, image_url: 'u', image_embedding: null }, // brand new
    ])
    expect(getUnembedded(10).map((p) => p.id).sort()).toEqual(['needimg', 'needtext'])
  })

  it('countUnembedded counts rows missing a text OR an image embedding (with a thumbnail)', () => {
    const tvec = vectorToBlob([1, 0, 0, 0])
    const ivec = vectorToBlob([0, 1, 0, 0])
    seed([
      { id: 'both', embedding: tvec, image_url: 'u', image_embedding: ivec }, // not counted
      { id: 'needimg', embedding: tvec, image_url: 'u', image_embedding: null }, // counted
      { id: 'needtext', embedding: null, image_url: null, image_embedding: null }, // counted
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

describe('video transcripts (§18)', () => {
  const VIDEO = JSON.stringify({ type: 'video', url: 'https://v', poster: 'https://p' })
  const IMAGE = JSON.stringify({ type: 'image', images: ['https://i'] })

  it('insertPosts + searchPosts round-trip the transcript column', () => {
    seed([{ id: 'a', transcript: 'hello world' }])
    expect(searchPosts({}).posts[0]!.transcript).toBe('hello world')
  })

  it('getVideoPostsMissingTranscript returns only Instagram video posts with a url and no transcript', () => {
    seed([
      { id: 'instagram-vid1', platform: 'instagram', media: VIDEO, url: 'https://www.instagram.com/p/vid1/', transcript: null },
      { id: 'instagram-vid2', platform: 'instagram', media: VIDEO, url: 'https://www.instagram.com/p/vid2/', transcript: 'done' }, // already transcribed
      { id: 'instagram-img1', platform: 'instagram', media: IMAGE, url: 'https://www.instagram.com/p/img1/', transcript: null }, // not a video
      { id: 'instagram-nourl', platform: 'instagram', media: VIDEO, url: null, transcript: null }, // no url to transcribe
      { id: 'li-vid', platform: 'linkedin', media: VIDEO, url: 'https://li/v', transcript: null }, // wrong platform
    ])
    expect(getVideoPostsMissingTranscript(10).map((p) => p.id)).toEqual(['instagram-vid1'])
  })

  it('getVideoPostsMissingTranscript respects the limit', () => {
    seed([
      { id: 'instagram-a', platform: 'instagram', media: VIDEO, url: 'https://www.instagram.com/p/a/', likes: 5 },
      { id: 'instagram-b', platform: 'instagram', media: VIDEO, url: 'https://www.instagram.com/p/b/', likes: 9 },
    ])
    const one = getVideoPostsMissingTranscript(1)
    expect(one).toHaveLength(1)
    expect(one[0]!.id).toBe('instagram-b') // most-liked first
  })

  it('setTranscript writes the transcript for a post', () => {
    seed([{ id: 'instagram-vid1', platform: 'instagram', media: VIDEO, url: 'https://www.instagram.com/p/vid1/' }])
    setTranscript('instagram-vid1', 'the spoken words')
    expect(searchPosts({}).posts[0]!.transcript).toBe('the spoken words')
    expect(getVideoPostsMissingTranscript(10)).toHaveLength(0) // now excluded
  })
})

describe('getPostById / getCorpusStats (§20 read-only API)', () => {
  it('getPostById returns the row or null', () => {
    seed([{ id: 'a', content: 'hello' }])
    expect(getPostById('a')!.content).toBe('hello')
    expect(getPostById('missing')).toBeNull()
  })

  it('getCorpusStats reports 0 (not null) for enrichment counts on an empty corpus', () => {
    const stats = getCorpusStats()
    expect(stats.totalPosts).toBe(0)
    expect(stats.enrichment).toEqual({ embedded: 0, imageEmbedded: 0, withTranscript: 0 })
    expect(stats.platforms).toEqual([])
    expect(stats.lastScrapedAt).toBeNull()
  })

  it('getCorpusStats summarizes platforms, markets, enrichment, and creators', () => {
    const vec = vectorToBlob([1, 0, 0, 0])
    seed([
      { id: 'a', platform: 'linkedin', market: 'ai', likes: 10, author_id: 'jane', embedding: vec, image_embedding: vec, posted_at: '2026-01-01T00:00:00.000Z', scraped_at: '2026-06-01T00:00:00.000Z' },
      { id: 'b', platform: 'linkedin', market: 'ai', likes: 5, author_id: 'joe', posted_at: '2026-02-01T00:00:00.000Z', scraped_at: '2026-06-02T00:00:00.000Z', transcript: 'words' },
      { id: 'c', platform: 'twitter', market: 'growth', likes: 1, author_id: 'jane', posted_at: '2026-03-01T00:00:00.000Z', scraped_at: '2026-06-03T00:00:00.000Z' },
    ])
    upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/in/jane', author_id: 'jane' })

    const stats = getCorpusStats()
    expect(stats.totalPosts).toBe(3)
    const linkedin = stats.platforms.find((p) => p.platform === 'linkedin')!
    expect(linkedin).toMatchObject({ posts: 2, authors: 2, totalLikes: 15 })
    expect(linkedin.oldestPost).toBe('2026-01-01T00:00:00.000Z')
    expect(linkedin.newestPost).toBe('2026-02-01T00:00:00.000Z')
    expect(stats.markets).toEqual([
      { market: 'ai', posts: 2 },
      { market: 'growth', posts: 1 },
    ])
    expect(stats.enrichment).toEqual({ embedded: 1, imageEmbedded: 1, withTranscript: 1 })
    expect(stats.creators).toBe(1)
    expect(stats.lastScrapedAt).toBe('2026-06-03T00:00:00.000Z')
  })
})

describe('searchPosts paging is never unbounded', () => {
  it('falls back to the defaults when page/pageSize are not finite numbers', () => {
    // A non-numeric ?pageSize= parses to NaN. Math.min/max propagate NaN, better-sqlite3 binds it as
    // NULL, and `LIMIT NULL` in SQLite means NO LIMIT — the whole corpus in one response.
    seed(Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` })))
    const nan = searchPosts({ page: Number.NaN, pageSize: Number.NaN })
    expect(nan.pageSize).toBe(50)
    expect(nan.page).toBe(1)
    expect(nan.posts).toHaveLength(5)

    const seeded = searchPosts({ pageSize: 2 })
    expect(seeded.posts).toHaveLength(2)
    expect(seeded.hasMore).toBe(true)
  })

  it('clamps a pageSize above the maximum and below one', () => {
    seed([{ id: 'a' }])
    expect(searchPosts({ pageSize: 5000 }).pageSize).toBe(200)
    expect(searchPosts({ pageSize: 0 }).pageSize).toBe(1)
    expect(searchPosts({ pageSize: -10 }).pageSize).toBe(1)
    expect(searchPosts({ page: -3 }).page).toBe(1)
  })
})

// FTS5 keyword search (§11.1). The `keywords` filter runs through the posts_fts index, not
// `content LIKE '%kw%'` — these tests pin the behavioural differences that motivated the change.
describe('searchPosts — FTS5 keyword matching', () => {
  it('matches whole words, not substrings', () => {
    seed([
      { id: 'real', content: 'Revenue ops and infra hiring' },
      { id: 'noise1', content: 'The AI stops drifting after a while' },
      { id: 'noise2', content: 'It loops through every lead' },
      { id: 'noise3', content: 'Power tops $2.4M this quarter' },
    ])
    expect(searchPosts({ keywords: ['ops'] }).posts.map((p) => p.id)).toEqual(['real'])
  })

  it('matches word forms via the porter stemmer (hire → hiring/hired/hires)', () => {
    seed([
      { id: 'a', content: 'We are hiring three engineers' },
      { id: 'b', content: 'I hired my first PM last month' },
      { id: 'c', content: 'Gardening tips for spring' },
    ])
    expect(searchPosts({ keywords: ['hire'] }).posts.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it("OR's terms by default (match='any' preserves the original keyword contract)", () => {
    seed([
      { id: 'a', content: 'cold email works' },
      { id: 'b', content: 'outbound is dead' },
      { id: 'c', content: 'gardening tips' },
    ])
    expect(searchPosts({ keywords: ['cold', 'outbound'] }).posts.map((p) => p.id).sort()).toEqual(['a', 'b'])
    expect(searchPosts({ keywords: ['cold', 'outbound'], match: 'any' }).posts).toHaveLength(2)
  })

  it("AND's terms under match='all' — the precision win over OR'd LIKEs", () => {
    seed([
      { id: 'all3', content: 'my cold outbound email system' },
      { id: 'two', content: 'cold email, but the inbound motion is what worked' },
      { id: 'one', content: 'just an email' },
    ])
    expect(
      searchPosts({ keywords: ['cold', 'outbound', 'email'], match: 'all' }).posts.map((p) => p.id),
    ).toEqual(['all3'])
  })

  it('treats a multi-word term as a phrase (adjacency required)', () => {
    seed([
      { id: 'phrase', content: 'my cold outbound system' },
      { id: 'apart', content: 'outbound is cold this quarter' },
    ])
    expect(searchPosts({ keywords: ['cold outbound'] }).posts.map((p) => p.id)).toEqual(['phrase'])
  })

  it("sort='relevance' orders by bm25 — the best match first, not the newest", () => {
    seed([
      { id: 'passing', content: 'a long post about many things, agents get one mention here', posted_at: '2026-06-03T00:00:00.000Z' },
      { id: 'dense', content: 'agents agents agents', posted_at: '2026-06-01T00:00:00.000Z' },
    ])
    expect(searchPosts({ keywords: ['agents'], sort: 'relevance' }).posts.map((p) => p.id)).toEqual([
      'dense',
      'passing',
    ])
    // Without a keyword there is nothing to score against: fall back to the default ordering.
    seed([{ id: 'newest', posted_at: '2026-09-01T00:00:00.000Z' }])
    expect(searchPosts({ sort: 'relevance' }).posts[0]!.id).toBe('newest')
  })

  it('returns nothing (not everything) when a keyword has no indexable token', () => {
    seed([{ id: 'a' }, { id: 'b' }])
    const res = searchPosts({ keywords: ['!!!'] })
    expect(res.posts).toEqual([])
    expect(res.total).toBe(0)
  })

  it('treats FTS5 operator syntax in a keyword as literal text instead of throwing', () => {
    seed([{ id: 'a', content: 'ai agents' }])
    for (const kw of ['NOT ai', 'ai OR', '"', 'col:val', '*', 'ai AND (']) {
      expect(() => searchPosts({ keywords: [kw] })).not.toThrow()
    }
  })

  it('composes with the other filters and with pagination', () => {
    seed([
      { id: 'a', content: 'ai agents', platform: 'linkedin', likes: 100 },
      { id: 'b', content: 'ai agents', platform: 'twitter', likes: 100 },
      { id: 'c', content: 'ai agents', platform: 'linkedin', likes: 1 },
      { id: 'd', content: 'gardening', platform: 'linkedin', likes: 100 },
    ])
    const res = searchPosts({ keywords: ['agents'], platforms: ['linkedin'], minLikes: 50 })
    expect(res.posts.map((p) => p.id)).toEqual(['a'])
    expect(res.total).toBe(1)

    const paged = searchPosts({ keywords: ['agents'], pageSize: 2 })
    expect(paged.posts).toHaveLength(2)
    expect(paged.total).toBe(3)
    expect(paged.hasMore).toBe(true)
  })

  it('applies the keyword filter to the author dropdown and the clustering candidate set', () => {
    seed([
      { id: 'a', content: 'ai agents', author_id: 'jane', embedding: vectorToBlob([1, 0, 0, 0]) },
      { id: 'b', content: 'gardening tips', author_id: 'joe', embedding: vectorToBlob([0, 1, 0, 0]) },
    ])
    expect(getAvailableAuthors({ keywords: ['agents'] }).map((a) => a.author_id)).toEqual(['jane'])
    expect(getCandidatesForClustering({ keywords: ['agents'] }, false).map((p) => p.id)).toEqual(['a'])
  })
})

describe('posts_fts index synchronisation', () => {
  it('indexes a post on insert', () => {
    seed([{ id: 'a', content: 'brand new post about agents' }])
    expect(searchPosts({ keywords: ['agents'] }).posts.map((p) => p.id)).toEqual(['a'])
  })

  it('drops a post from the index when the row is deleted', () => {
    seed([{ id: 'a', content: 'ai agents' }])
    getDb().prepare('DELETE FROM posts WHERE id = ?').run('a')
    expect(searchPosts({ keywords: ['agents'] }).posts).toEqual([])
  })

  it('re-indexes when content is updated', () => {
    seed([{ id: 'a', content: 'ai agents' }])
    getDb().prepare('UPDATE posts SET content = ? WHERE id = ?').run('gardening tips', 'a')
    expect(searchPosts({ keywords: ['agents'] }).posts).toEqual([])
    expect(searchPosts({ keywords: ['gardening'] }).posts.map((p) => p.id)).toEqual(['a'])
  })

  it('survives a null-content post (nothing to index, no crash)', () => {
    seed([{ id: 'a', content: null }, { id: 'b', content: 'ai agents' }])
    expect(searchPosts({ keywords: ['agents'] }).posts.map((p) => p.id)).toEqual(['b'])
    expect(() => getDb().prepare('DELETE FROM posts WHERE id = ?').run('a')).not.toThrow()
  })

  it('is not disturbed by enrichment writes that leave content alone', () => {
    seed([{ id: 'a', content: 'ai agents' }])
    setEmbedding('a', vectorToBlob([1, 0, 0, 0]), '2026-06-01T00:00:00.000Z')
    updateXFactor('a', { weighted_score: 10, creator_baseline: 2, x_factor: 5 })
    setTranscript('a', 'spoken words')
    expect(searchPosts({ keywords: ['agents'] }).posts.map((p) => p.id)).toEqual(['a'])
  })
})
