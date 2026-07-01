// Layer 0 — in-memory deduplication (PRD §10.4). Zero I/O. 100% coverage required.

import type { PostRow, ScrapeSource } from '@/lib/types'

/**
 * Merge keyword + creator arrays into a Map keyed by id. A post present in both sources gets
 * scrape_source 'both'; otherwise 'keyword' or 'creator'. Rows with null/empty id are skipped.
 * First-wins on row data. Does not mutate inputs.
 */
export function mergeAndDeduplicate(
  keyword: PostRow[],
  creator: PostRow[],
): { posts: PostRow[]; duplicates: number; foundInBoth: number } {
  const map = new Map<string, PostRow>()
  let validInputs = 0
  let foundInBoth = 0

  const ingest = (rows: PostRow[], source: Exclude<ScrapeSource, 'both'>): void => {
    for (const row of rows) {
      if (!row.id) continue // skip null/empty id
      validInputs++
      const existing = map.get(row.id)
      if (!existing) {
        map.set(row.id, { ...row, scrape_source: source })
      } else if (existing.scrape_source !== source && existing.scrape_source !== 'both') {
        // seen in the other source -> promote to 'both' (first-wins on the row data itself)
        existing.scrape_source = 'both'
        foundInBoth++
      }
      // same-source duplicate: first-wins, nothing to update
    }
  }

  ingest(keyword, 'keyword')
  ingest(creator, 'creator')

  const posts = [...map.values()]
  return { posts, duplicates: validInputs - posts.length, foundInBoth }
}

/**
 * Fingerprint dedup (Level 2): collapse rows sharing author_id | author_name | first 200 chars of
 * content — catches reposts with different ids. First-wins.
 */
export function deduplicatePosts(posts: PostRow[]): PostRow[] {
  const seen = new Set<string>()
  const out: PostRow[] = []
  for (const p of posts) {
    const fingerprint = `${p.author_id ?? ''}|${p.author_name ?? ''}|${(p.content ?? '').slice(0, 200)}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push(p)
  }
  return out
}
