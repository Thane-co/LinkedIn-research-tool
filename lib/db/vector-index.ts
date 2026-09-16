// Layer 2 — the in-memory vector index behind semantic retrieval (PRD §9.5).
//
// Why a cache at all: the vectors live as Float32 BLOBs on `posts`, and decoding ~90k of them per
// query (≈360MB of blob reads) would dominate the query. So they are decoded ONCE into a single flat
// Float32Array and reused. Each row is unit-normalized on the way in, which turns every later cosine
// similarity into a plain dot product.
//
// Deliberately NOT a vector database: this stays a local SQLite tool (no pgvector, no external
// service). Measured on the real corpus (89,018 × 1024): the matrix is 348MB, the one-time build
// takes ~3.6s, and a full scan is ~150ms per query. An approximate index would trade that for
// recall loss and a second thing to keep in sync.
//
// The index is built LAZILY on the first semantic query, so a session that only ever runs keyword
// search never pays for the memory or the build.

import type Database from 'better-sqlite3'
import { getDb } from '@/lib/db/db'
import { getEmbeddingStats, iterateEmbeddedVectors } from '@/lib/db/posts.repo'
import { blobToVector } from '@/lib/pure/vector-blob'
import { normalized, topKSimilar } from '@/lib/pure/vector-search'

export interface VectorIndex {
  /** Post id for each row of `matrix`, in row order. */
  ids: string[]
  /** Row-major, normalized: row i occupies [i*dim, (i+1)*dim). */
  matrix: Float32Array
  dim: number
  rowCount: number
  /** Vectors rejected for disagreeing with `dim` — surfaced rather than swallowed. */
  skipped: number
}

const EMPTY: VectorIndex = { ids: [], matrix: new Float32Array(0), dim: 0, rowCount: 0, skipped: 0 }

let cached: VectorIndex | null = null
/** The connection `cached` was built from. A different one means a different corpus entirely. */
let cachedFrom: Database.Database | null = null

/**
 * Drop the cached index so the next query rebuilds it. Call after writing embeddings (the enrich
 * job, the backfill script); otherwise newly embedded posts stay invisible to semantic search for
 * the life of the process.
 */
export function resetVectorIndex(): void {
  cached = null
  cachedFrom = null
}

/** Build (or return) the index for the current database. */
export function getVectorIndex(): VectorIndex {
  const db = getDb()
  // Identity check, not a row count: swapping the db (tests, DB_PATH) must never reuse a cache built
  // from another file, and comparing the connection is free.
  if (cached && cachedFrom === db) return cached

  const { count, dim } = getEmbeddingStats()
  if (count === 0 || dim === 0) {
    cached = { ...EMPTY }
    cachedFrom = db
    return cached
  }

  // Allocated once, filled by streaming — never an intermediate array of decoded vectors.
  const matrix = new Float32Array(count * dim)
  const ids: string[] = []
  let filled = 0
  let skipped = 0

  for (const row of iterateEmbeddedVectors()) {
    // A row appended after the count was taken has nowhere to go; it arrives on the next rebuild.
    if (filled >= count) {
      skipped++
      continue
    }
    const vector = blobToVector(row.embedding)
    // A vector of another width is from another model: including it would misalign every row after
    // it in the flat matrix, silently corrupting all subsequent results.
    if (vector === null || vector.length !== dim) {
      skipped++
      continue
    }
    matrix.set(normalized(vector), filled * dim)
    ids.push(row.id)
    filled++
  }

  cached = {
    ids,
    // subarray VIEWS the same buffer (no copy); it only matters when rows were skipped.
    matrix: filled === count ? matrix : matrix.subarray(0, filled * dim),
    dim,
    rowCount: filled,
    skipped,
  }
  cachedFrom = db
  return cached
}

/**
 * The `limit` post ids most similar to `query`, best first.
 *
 * `allowed` is the hard-filtered candidate set (platform / engagement / x-factor / timeframe), or
 * null for "no restriction". It is applied DURING the scan, not after, so a narrow filter still
 * yields a full `limit` of results rather than whatever survives an unfiltered top-N.
 */
export function searchSimilar(query: number[], allowed: Set<string> | null, limit: number): string[] {
  const index = getVectorIndex()
  if (index.rowCount === 0 || query.length !== index.dim) return []

  const unit = normalized(query)
  // An all-zero query has no direction: every dot product is 0 and the "ranking" would be arbitrary.
  if (unit.every((v) => v === 0)) return []

  const isAllowed = allowed === null ? (): boolean => true : (i: number): boolean => allowed.has(index.ids[i]!)
  return topKSimilar(index.matrix, index.dim, index.rowCount, Float32Array.from(unit), isAllowed, limit).map(
    (hit) => index.ids[hit.index]!,
  )
}
