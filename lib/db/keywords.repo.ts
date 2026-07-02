// Layer 6 — keyword sets per market (PRD §6.5, §11.6). Storage only. A market is a user-defined
// label; the market set is the distinct `market` column. Feeds the Keywords editor and prefills a
// manual scrape's keyword set.

import { getDb } from '@/lib/db/db'

export interface KeywordRow {
  id: string
  market: string
  term: string
  created_at: string
}

export interface KeywordGroup {
  market: string
  terms: KeywordRow[]
}

/** Insert a keyword (INSERT OR IGNORE on the unique (market, term)); returns the (possibly existing) row. */
export function addKeyword(market: string, term: string): KeywordRow {
  const db = getDb()
  db.prepare(
    'INSERT OR IGNORE INTO keywords (id, market, term, created_at) VALUES (?, ?, ?, ?)',
  ).run(crypto.randomUUID(), market, term, new Date().toISOString())
  return db
    .prepare('SELECT id, market, term, created_at FROM keywords WHERE market = ? AND term = ?')
    .get(market, term) as KeywordRow
}

/** All keywords grouped by market (markets ordered alphabetically, terms oldest-first). */
export function listKeywords(): KeywordGroup[] {
  const rows = getDb()
    .prepare('SELECT id, market, term, created_at FROM keywords ORDER BY market ASC, created_at ASC')
    .all() as KeywordRow[]
  const groups = new Map<string, KeywordRow[]>()
  for (const row of rows) {
    const terms = groups.get(row.market) ?? []
    terms.push(row)
    groups.set(row.market, terms)
  }
  return [...groups.entries()].map(([market, terms]) => ({ market, terms }))
}

export function deleteKeyword(id: string): void {
  getDb().prepare('DELETE FROM keywords WHERE id = ?').run(id)
}

export function deleteMarket(market: string): void {
  getDb().prepare('DELETE FROM keywords WHERE market = ?').run(market)
}
