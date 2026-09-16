// Layer 0 — vector retrieval math + rank fusion (PRD §9.5). Zero I/O. 100% coverage required.
// Dimension-agnostic so tests can use tiny 4-dim vectors.

export interface ScoredIndex {
  index: number
  score: number
}

export interface FusedId {
  id: string
  score: number
}

/**
 * Scale a vector to unit length. Once every stored vector AND the query are unit vectors, cosine
 * similarity is just the dot product — no per-comparison magnitude to recompute, which is what
 * makes a brute-force scan over ~90k rows cheap enough to do per query.
 *
 * A zero-magnitude vector is returned unchanged (mirrors `cosine`, which reports 0 rather than NaN).
 */
export function normalized(vec: number[]): number[] {
  let sum = 0
  for (const v of vec) sum += v * v
  if (sum === 0) return vec
  const magnitude = Math.sqrt(sum)
  return vec.map((v) => v / magnitude)
}

/**
 * The `k` rows of `matrix` most similar to `query`, best first. `matrix` is row-major and flat
 * (row i occupies [i*dim, (i+1)*dim)); both it and `query` must already be normalized.
 *
 * `isAllowed` is applied BEFORE scoring, not after: hard filters (minXFactor, timeframe, platform)
 * have to shape the candidate pool, or a narrow filter would rank the whole corpus and then throw
 * nearly all of it away, returning far fewer than k results that pass.
 */
export function topKSimilar(
  matrix: Float32Array,
  dim: number,
  rowCount: number,
  query: Float32Array,
  isAllowed: (index: number) => boolean,
  k: number,
): ScoredIndex[] {
  const hits: ScoredIndex[] = []
  for (let row = 0; row < rowCount; row++) {
    if (!isAllowed(row)) continue
    let dot = 0
    const base = row * dim
    for (let d = 0; d < dim; d++) dot += matrix[base + d]! * query[d]!
    hits.push({ index: row, score: dot })
  }
  // Array.prototype.sort is stable, so equal scores keep ascending row order.
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

/**
 * Reciprocal Rank Fusion: merge several ranked id lists into one, scoring each id `1/(k + rank)`
 * summed over the lists it appears in (rank is 1-based).
 *
 * Why RRF rather than blending the raw scores: bm25 and cosine are on unrelated scales (bm25 is an
 * unbounded negative, cosine is [-1, 1]) and their distributions shift with every query, so any
 * fixed weighting of the two is arbitrary. RRF only reads POSITION, so it needs no normalization and
 * no tuning, and it rewards agreement — an id both retrievers rank highly beats one that a single
 * retriever loves. `k` damps the influence of the very top ranks; 60 is the standard default.
 */
export function reciprocalRankFusion(rankedLists: string[][], k: number): FusedId[] {
  const scores = new Map<string, number>()
  const order: string[] = [] // first-appearance order, so equal scores sort deterministically

  for (const list of rankedLists) {
    const seen = new Set<string>()
    let rank = 0
    for (const id of list) {
      if (seen.has(id)) continue // a repeated id keeps its best (first) rank only
      seen.add(id)
      rank++
      if (!scores.has(id)) order.push(id)
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank))
    }
  }

  return order
    .map((id) => ({ id, score: scores.get(id)! }))
    .sort((a, b) => b.score - a.score)
}
