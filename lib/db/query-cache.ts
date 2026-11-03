// Layer 2 — memo for aggregate reads that full-scan `posts` (the author dropdown, corpus stats).
//
// Why: `posts` rows are fat (raw_data + two 4KB vectors + transcripts, ~13KB/row), so a GROUP BY over
// ~90k posts reads ~1GB. Measured on the real corpus: 0.3s warm, 3.6s when the OS has evicted the
// file — and the author dropdown ran on EVERY search. Its answer only changes when the db does.
//
// Invalidation is exact, not time-based: the cache is keyed on
//   - the connection identity (tests / DB_PATH swaps never reuse another file's answers),
//   - `PRAGMA data_version`, which changes when ANOTHER connection commits (scrape jobs, scripts),
//   - `total_changes()`, which changes when THIS connection writes (in-app scrapes, refreshes).
// Both are O(1) reads. A TTL is added only because relative timeframes ('24h', 'month') slide with
// the clock even when no data changes.

import type Database from 'better-sqlite3'
import { getDb } from '@/lib/db/db'

const TTL_MS = 10 * 60 * 1000
/** Distinct filter combinations kept per db version — bounds memory under arbitrary agent queries. */
const MAX_ENTRIES = 200

let cacheFor: Database.Database | null = null
let cacheVersion = ''
const entries = new Map<string, { value: unknown; at: number }>()

function versionOf(db: Database.Database): string {
  const dataVersion = db.pragma('data_version', { simple: true }) as number
  const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  return `${dataVersion}:${changes}`
}

/** Return the cached result for `key`, computing it if the db changed, it expired, or it's absent. */
export function cachedQuery<T>(key: string, compute: () => T): T {
  const db = getDb()
  const version = versionOf(db)
  if (cacheFor !== db || cacheVersion !== version) {
    entries.clear()
    cacheFor = db
    cacheVersion = version
  }
  const hit = entries.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T

  const value = compute()
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!)
  entries.set(key, { value, at: Date.now() })
  return value
}

/** Drop everything (test isolation). */
export function resetQueryCache(): void {
  entries.clear()
  cacheFor = null
  cacheVersion = ''
}
