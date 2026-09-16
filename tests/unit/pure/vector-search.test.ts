import { describe, expect, it } from 'vitest'
import { normalized, reciprocalRankFusion, topKSimilar } from '@/lib/pure/vector-search'

// Dimension-agnostic by design (PRD §13) — 4-dim vectors keep these readable.
const DIM = 4
/** Pack rows into the flat, row-major Float32Array the index holds. */
const matrix = (rows: number[][]): Float32Array => Float32Array.from(rows.flat())
const all = (): boolean => true

describe('normalized', () => {
  it('scales a vector to unit length', () => {
    expect(normalized([3, 4, 0, 0])).toEqual([0.6, 0.8, 0, 0])
  })

  it('leaves an already-unit vector alone', () => {
    expect(normalized([1, 0, 0, 0])).toEqual([1, 0, 0, 0])
  })

  it('returns a zero vector unchanged instead of dividing by zero', () => {
    expect(normalized([0, 0, 0, 0])).toEqual([0, 0, 0, 0])
  })
})

describe('topKSimilar', () => {
  // Rows are pre-normalized, so the dot product IS the cosine similarity.
  const rows = matrix([
    [1, 0, 0, 0], // 0 — identical to the query
    [0, 1, 0, 0], // 1 — orthogonal
    [0.6, 0.8, 0, 0], // 2 — partial match
    [-1, 0, 0, 0], // 3 — opposite
  ])
  const query = Float32Array.from([1, 0, 0, 0])

  it('ranks rows by cosine similarity, best first', () => {
    const hits = topKSimilar(rows, DIM, 4, query, all, 4)
    expect(hits.map((h) => h.index)).toEqual([0, 2, 1, 3])
    expect(hits[0]!.score).toBeCloseTo(1)
    expect(hits[1]!.score).toBeCloseTo(0.6)
    expect(hits[3]!.score).toBeCloseTo(-1)
  })

  it('returns at most k rows', () => {
    expect(topKSimilar(rows, DIM, 4, query, all, 2).map((h) => h.index)).toEqual([0, 2])
  })

  it('skips rows the filter excludes, rather than ranking then filtering', () => {
    // Excluding the two best must SURFACE the next ones, not shrink the result to nothing —
    // this is what makes a hard pre-filter (minXFactor, timeframe) compose with vector search.
    const hits = topKSimilar(rows, DIM, 4, query, (i) => i !== 0 && i !== 2, 2)
    expect(hits.map((h) => h.index)).toEqual([1, 3])
  })

  it('returns nothing when every row is filtered out', () => {
    expect(topKSimilar(rows, DIM, 4, query, () => false, 4)).toEqual([])
  })

  it('handles an empty index', () => {
    expect(topKSimilar(new Float32Array(0), DIM, 0, query, all, 4)).toEqual([])
  })

  it('is stable for equal scores (lower row index first)', () => {
    const tied = matrix([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ])
    expect(topKSimilar(tied, DIM, 3, query, all, 3).map((h) => h.index)).toEqual([0, 1, 2])
  })
})

describe('reciprocalRankFusion', () => {
  it('ranks an id found by both retrievers above one found by only the stronger', () => {
    // 'b' is 2nd and 1st; 'a' is 1st in one list only. Agreement beats a single top placement.
    const fused = reciprocalRankFusion([['a', 'b'], ['b', 'c']], 60)
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'c'])
  })

  it('scores by 1/(k + rank), summed across the lists it appears in', () => {
    const fused = reciprocalRankFusion([['a'], ['a']], 60)
    expect(fused[0]!.score).toBeCloseTo(2 / 61)
  })

  it('keeps ids that only one retriever found (union, not intersection)', () => {
    // The whole point of the union: a post the keyword search cannot reach still gets through.
    const fused = reciprocalRankFusion([['a'], ['z']], 60)
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'z'])
  })

  it('ignores empty lists and returns nothing for no input', () => {
    expect(reciprocalRankFusion([[], []], 60)).toEqual([])
    expect(reciprocalRankFusion([], 60)).toEqual([])
  })

  it('de-duplicates within a single list, keeping the best rank', () => {
    const fused = reciprocalRankFusion([['a', 'a', 'b']], 60)
    expect(fused.map((f) => f.id)).toEqual(['a', 'b'])
    expect(fused[0]!.score).toBeCloseTo(1 / 61)
  })

  it('breaks score ties by first appearance, so the order is deterministic', () => {
    const fused = reciprocalRankFusion([['a'], ['b']], 60)
    expect(fused.map((f) => f.id)).toEqual(['a', 'b'])
  })

  it('lets a smaller k sharpen the advantage of a top-ranked hit', () => {
    // With k=1, rank 1 (1/2) vastly outweighs rank 2 (1/3); with a large k the gap narrows.
    const sharp = reciprocalRankFusion([['a', 'b'], ['b', 'a']], 1)
    expect(sharp[0]!.score).toBeCloseTo(1 / 2 + 1 / 3)
  })
})
