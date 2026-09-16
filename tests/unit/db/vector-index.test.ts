import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts, setEmbedding } from '@/lib/db/posts.repo'
import { getVectorIndex, resetVectorIndex, searchSimilar } from '@/lib/db/vector-index'
import { vectorToBlob } from '@/lib/pure/vector-blob'
import { makePostRow } from '@/tests/fixtures/posts'

beforeEach(() => {
  getDb(':memory:')
  resetVectorIndex()
})
afterEach(() => {
  resetDb()
  resetVectorIndex()
})

/** Seed a post carrying `vec` as its text embedding. */
const seedVec = (id: string, vec: number[] | null, over = {}): void => {
  insertPosts([makePostRow({ id, embedding: vec ? vectorToBlob(vec) : null, ...over })])
}

describe('getVectorIndex', () => {
  it('loads every embedded post, and only embedded posts', () => {
    seedVec('a', [1, 0, 0, 0])
    seedVec('b', [0, 1, 0, 0])
    seedVec('unembedded', null)
    const index = getVectorIndex()
    expect(index.ids.sort()).toEqual(['a', 'b'])
    expect(index.rowCount).toBe(2)
    expect(index.dim).toBe(4)
  })

  it('normalizes rows on load, so a query is a dot product rather than a cosine', () => {
    seedVec('a', [3, 4, 0, 0]) // magnitude 5
    const index = getVectorIndex()
    expect(index.matrix[0]).toBeCloseTo(0.6)
    expect(index.matrix[1]).toBeCloseTo(0.8)
  })

  it('is built once and reused', () => {
    seedVec('a', [1, 0, 0, 0])
    expect(getVectorIndex()).toBe(getVectorIndex())
  })

  it('rebuilds after resetVectorIndex, picking up newly embedded posts', () => {
    seedVec('a', [1, 0, 0, 0])
    expect(getVectorIndex().rowCount).toBe(1)

    seedVec('b', null)
    setEmbedding('b', vectorToBlob([0, 1, 0, 0]), '2026-06-01T00:00:00.000Z')
    expect(getVectorIndex().rowCount).toBe(1) // still the cached build

    resetVectorIndex()
    expect(getVectorIndex().rowCount).toBe(2)
  })

  it('rebuilds when the underlying database changes, so a cache cannot leak across dbs', () => {
    seedVec('a', [1, 0, 0, 0])
    expect(getVectorIndex().rowCount).toBe(1)

    getDb(':memory:') // a different connection entirely
    expect(getVectorIndex().rowCount).toBe(0)
  })

  it('is empty, not broken, when nothing is embedded yet', () => {
    seedVec('a', null)
    const index = getVectorIndex()
    expect(index.rowCount).toBe(0)
    expect(index.ids).toEqual([])
  })

  it('skips a vector whose width disagrees with the rest instead of corrupting the matrix', () => {
    // A row embedded by a different model would silently misalign every subsequent row.
    seedVec('good', [1, 0, 0, 0])
    seedVec('wrong-width', [1, 0])
    const index = getVectorIndex()
    expect(index.ids).toEqual(['good'])
    expect(index.skipped).toBe(1)
  })
})

describe('searchSimilar', () => {
  const seedCorpus = (): void => {
    seedVec('exact', [1, 0, 0, 0], { likes: 5 })
    seedVec('close', [0.6, 0.8, 0, 0], { likes: 500 })
    seedVec('orthogonal', [0, 1, 0, 0], { likes: 1000 })
  }

  it('returns ids ordered by similarity to the query', () => {
    seedCorpus()
    expect(searchSimilar([1, 0, 0, 0], null, 10)).toEqual(['exact', 'close', 'orthogonal'])
  })

  it('normalizes the query, so an unnormalized one ranks identically', () => {
    seedCorpus()
    expect(searchSimilar([50, 0, 0, 0], null, 10)).toEqual(['exact', 'close', 'orthogonal'])
  })

  it('honours the limit', () => {
    seedCorpus()
    expect(searchSimilar([1, 0, 0, 0], null, 2)).toEqual(['exact', 'close'])
  })

  it('restricts results to the allowed id set (hard pre-filters)', () => {
    seedCorpus()
    const allowed = new Set(['close', 'orthogonal'])
    expect(searchSimilar([1, 0, 0, 0], allowed, 10)).toEqual(['close', 'orthogonal'])
  })

  it('returns nothing when the allowed set excludes everything', () => {
    seedCorpus()
    expect(searchSimilar([1, 0, 0, 0], new Set<string>(), 10)).toEqual([])
  })

  it('returns nothing on an empty index rather than throwing', () => {
    expect(searchSimilar([1, 0, 0, 0], null, 10)).toEqual([])
  })

  it('returns nothing for a zero-magnitude query, which has no direction to match', () => {
    seedCorpus()
    expect(searchSimilar([0, 0, 0, 0], null, 10)).toEqual([])
  })

  it('returns nothing when the query width disagrees with the index', () => {
    seedCorpus()
    expect(searchSimilar([1, 0], null, 10)).toEqual([])
  })
})
