import { describe, expect, it } from 'vitest'
import { combined, cosine, pairwiseSimilarityMean } from '@/lib/pure/similarity'

describe('cosine', () => {
  it('is 1 for identical vectors', () => {
    expect(cosine([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 10)
  })

  it('is 1 for parallel (scaled) vectors', () => {
    expect(cosine([1, 0, 0, 0], [3, 0, 0, 0])).toBeCloseTo(1, 10)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0, 0, 0], [0, 1, 0, 0])).toBeCloseTo(0, 10)
  })

  it('is -1 for opposite vectors', () => {
    expect(cosine([1, 2, 0, 0], [-1, -2, 0, 0])).toBeCloseTo(-1, 10)
  })

  it('returns 0 when either vector is all-zero (no division by zero)', () => {
    expect(cosine([0, 0, 0, 0], [1, 2, 3, 4])).toBe(0)
    expect(cosine([1, 2, 3, 4], [0, 0, 0, 0])).toBe(0)
  })
})

describe('combined', () => {
  const text = [1, 0, 0, 0]
  const img = [0, 1, 0, 0]

  it('falls back to text-only cosine when either image embedding is missing', () => {
    const p = { textEmbedding: text, imageEmbedding: null }
    const q = { textEmbedding: [1, 0, 0, 0], imageEmbedding: img }
    expect(combined(p, q)).toBeCloseTo(1, 10) // text cosine only
  })

  it('applies the 0.75 text / 0.25 image weighting when both have images', () => {
    // text cosine = 1 (identical), image cosine = 0 (orthogonal) -> 0.75*1 + 0.25*0 = 0.75
    const p = { textEmbedding: text, imageEmbedding: [1, 0, 0, 0] }
    const q = { textEmbedding: [1, 0, 0, 0], imageEmbedding: [0, 1, 0, 0] }
    expect(combined(p, q)).toBeCloseTo(0.75, 10)
  })
})

describe('pairwiseSimilarityMean', () => {
  it('averages the value over every unordered pair', () => {
    // pairs (0,1)=2, (0,2)=4, (1,2)=6 -> mean = 4
    const m = [
      [0, 2, 4],
      [2, 0, 6],
      [4, 6, 0],
    ]
    expect(pairwiseSimilarityMean(3, (a, b) => m[a]![b]!)).toBe(4)
  })

  it('returns 0 when there are no pairs (n < 2)', () => {
    expect(pairwiseSimilarityMean(1, () => 5)).toBe(0)
    expect(pairwiseSimilarityMean(0, () => 5)).toBe(0)
  })
})
