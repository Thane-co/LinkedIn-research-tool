import { describe, expect, it } from 'vitest'
import { buildFtsMatch, hasIndexableToken } from '@/lib/pure/fts-query'

describe('hasIndexableToken', () => {
  it('is true for a term with a letter or a digit', () => {
    expect(hasIndexableToken('ai')).toBe(true)
    expect(hasIndexableToken('2026')).toBe(true)
    expect(hasIndexableToken('C++')).toBe(true)
  })

  it('is false for whitespace, punctuation, and emoji only', () => {
    expect(hasIndexableToken('')).toBe(false)
    expect(hasIndexableToken('   ')).toBe(false)
    expect(hasIndexableToken('!!!')).toBe(false)
    expect(hasIndexableToken('"')).toBe(false)
    expect(hasIndexableToken('🔥🔥')).toBe(false)
  })

  it('is true for non-Latin letters (unicode61 tokenizes them)', () => {
    expect(hasIndexableToken('日本語')).toBe(true)
    expect(hasIndexableToken('éclair')).toBe(true)
  })
})

describe('buildFtsMatch', () => {
  it('quotes a single term as a phrase', () => {
    expect(buildFtsMatch(['hiring'], 'any')).toBe('"hiring"')
  })

  it("OR's terms under 'any' (the default keyword contract)", () => {
    expect(buildFtsMatch(['ai', 'cloud'], 'any')).toBe('"ai" OR "cloud"')
  })

  it("AND's terms under 'all'", () => {
    expect(buildFtsMatch(['cold', 'outbound', 'email'], 'all')).toBe('"cold" AND "outbound" AND "email"')
  })

  it('keeps a multi-word term as one phrase, so word order and adjacency are required', () => {
    expect(buildFtsMatch(['cold outbound'], 'any')).toBe('"cold outbound"')
  })

  it('escapes an embedded double quote by doubling it (FTS5 string escaping)', () => {
    // Otherwise `say "no"` would close the phrase early and the rest would parse as operators.
    expect(buildFtsMatch(['say "no"'], 'any')).toBe('"say ""no"""')
  })

  it('neutralizes FTS5 operator syntax by quoting — it is searched, not executed', () => {
    expect(buildFtsMatch(['NOT ai', 'a OR b', 'col:val', 'pre*'], 'any')).toBe(
      '"NOT ai" OR "a OR b" OR "col:val" OR "pre*"',
    )
  })

  it('trims surrounding whitespace on each term', () => {
    expect(buildFtsMatch(['  ai  ', '\tcloud\n'], 'any')).toBe('"ai" OR "cloud"')
  })

  it('drops terms with no indexable token rather than emitting an empty phrase', () => {
    // `""` is a syntax error in FTS5 — it would throw at query time, not return zero rows.
    expect(buildFtsMatch(['ai', '!!!', '   '], 'any')).toBe('"ai"')
  })

  it('returns null when no term survives, so the caller can decide what "unsearchable" means', () => {
    expect(buildFtsMatch(['!!!'], 'any')).toBeNull()
    expect(buildFtsMatch([], 'any')).toBeNull()
    expect(buildFtsMatch(['', '  '], 'all')).toBeNull()
  })

  it('de-duplicates repeated terms (case-insensitively) so a term is not scored twice', () => {
    expect(buildFtsMatch(['ai', 'AI', ' ai '], 'any')).toBe('"ai"')
  })
})
