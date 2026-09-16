// Layer 0 — turn user keyword terms into an FTS5 MATCH expression (PRD §11.1). Zero I/O.
//
// Every term is wrapped in double quotes, which does two jobs at once:
//   1. it makes a multi-word term a PHRASE (adjacency + order required), and
//   2. it neutralizes FTS5's query syntax — AND/OR/NOT/NEAR, `*`, `^`, `:`, `-`, `(` — so a keyword
//      the user typed is SEARCHED FOR, never EXECUTED. Unquoted, `col:val` is a column filter and a
//      stray `"` is a syntax error that throws at query time instead of returning zero rows.
// Inside a quoted FTS5 string the only escape is doubling an embedded `"`.

import type { MatchMode } from '@/lib/types'

/**
 * Does this term contain anything the unicode61 tokenizer will actually index? Tokens are runs of
 * letters/digits, so a term of pure punctuation, whitespace, or emoji indexes to NOTHING — and the
 * empty phrase `""` is an FTS5 syntax error. Such terms are dropped before they reach SQLite.
 */
export function hasIndexableToken(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term)
}

/**
 * Build the MATCH expression for `keywords`, or null when no term is searchable (so the caller can
 * decide what an unsearchable query means — see searchPosts, where it means zero rows, never all).
 *
 * `any` OR's the terms (the historical keyword contract); `all` AND's them.
 */
export function buildFtsMatch(keywords: string[], mode: MatchMode): string | null {
  const seen = new Set<string>()
  const phrases: string[] = []

  for (const raw of keywords) {
    const term = raw.trim()
    if (!hasIndexableToken(term)) continue
    // Case-insensitive de-dup: FTS5 matching is case-insensitive anyway, and a repeated term would
    // otherwise be scored twice by bm25.
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    phrases.push(`"${term.replace(/"/g, '""')}"`)
  }

  if (phrases.length === 0) return null
  return phrases.join(mode === 'all' ? ' AND ' : ' OR ')
}
