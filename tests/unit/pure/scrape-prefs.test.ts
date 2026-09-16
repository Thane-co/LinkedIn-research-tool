// Layer 0 — per-platform scrape preferences (PRD §11.8). Pure parse/serialize, no I/O.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCRAPE_PREFS,
  PLATFORM_SUPPORTS_KEYWORDS,
  parseScrapePrefs,
  prefsToMode,
  serializeScrapePrefs,
} from '@/lib/pure/scrape-prefs'

describe('DEFAULT_SCRAPE_PREFS', () => {
  it('covers every platform', () => {
    expect(Object.keys(DEFAULT_SCRAPE_PREFS).sort()).toEqual(['instagram', 'linkedin', 'substack', 'twitter'])
  })

  it('gives twitter a likes floor (the actor filters before billing)', () => {
    expect(DEFAULT_SCRAPE_PREFS.twitter.minimumFavorites).toBeGreaterThan(0)
  })

  it('leaves instagram keyword-off — its actor is profile-only', () => {
    expect(PLATFORM_SUPPORTS_KEYWORDS.instagram).toBe(false)
    expect(DEFAULT_SCRAPE_PREFS.instagram.keywords).toBe(false)
  })
})

describe('parseScrapePrefs', () => {
  it('returns the defaults for undefined / empty / malformed json', () => {
    expect(parseScrapePrefs(undefined)).toEqual(DEFAULT_SCRAPE_PREFS)
    expect(parseScrapePrefs('')).toEqual(DEFAULT_SCRAPE_PREFS)
    expect(parseScrapePrefs('{not json')).toEqual(DEFAULT_SCRAPE_PREFS)
    expect(parseScrapePrefs('[]')).toEqual(DEFAULT_SCRAPE_PREFS)
  })

  it('merges a partial stored object over the defaults', () => {
    const parsed = parseScrapePrefs(JSON.stringify({ linkedin: { timeframe: 'month', keywords: false } }))
    expect(parsed.linkedin.timeframe).toBe('month')
    expect(parsed.linkedin.keywords).toBe(false)
    expect(parsed.linkedin.creators).toBe(DEFAULT_SCRAPE_PREFS.linkedin.creators)
    expect(parsed.twitter).toEqual(DEFAULT_SCRAPE_PREFS.twitter)
  })

  it('ignores unknown platforms and unknown fields', () => {
    const parsed = parseScrapePrefs(JSON.stringify({ myspace: { creators: true }, linkedin: { bogus: 1 } }))
    expect(Object.keys(parsed).sort()).toEqual(['instagram', 'linkedin', 'substack', 'twitter'])
    expect(parsed.linkedin).toEqual(DEFAULT_SCRAPE_PREFS.linkedin)
  })

  it('rejects a timeframe that is not in the enum', () => {
    expect(parseScrapePrefs(JSON.stringify({ linkedin: { timeframe: 'fortnight' } })).linkedin.timeframe).toBe(
      DEFAULT_SCRAPE_PREFS.linkedin.timeframe,
    )
  })

  it('forces keywords off for a platform whose actor has no keyword mode', () => {
    expect(parseScrapePrefs(JSON.stringify({ instagram: { keywords: true } })).instagram.keywords).toBe(false)
  })

  it('clamps a negative or non-numeric likes floor to undefined', () => {
    expect(parseScrapePrefs(JSON.stringify({ twitter: { minimumFavorites: -5 } })).twitter.minimumFavorites).toBeUndefined()
    expect(parseScrapePrefs(JSON.stringify({ twitter: { minimumFavorites: 'lots' } })).twitter.minimumFavorites).toBeUndefined()
    expect(parseScrapePrefs(JSON.stringify({ twitter: { minimumFavorites: 0 } })).twitter.minimumFavorites).toBeUndefined()
  })

  it('round-trips through serialize', () => {
    const prefs = parseScrapePrefs(JSON.stringify({ twitter: { minimumFavorites: 500, timeframe: '3d' } }))
    expect(parseScrapePrefs(serializeScrapePrefs(prefs))).toEqual(prefs)
  })
})

describe('prefsToMode', () => {
  it('maps the toggle pair to a scrape mode', () => {
    expect(prefsToMode({ creators: true, keywords: true, timeframe: 'week' })).toBe('both')
    expect(prefsToMode({ creators: true, keywords: false, timeframe: 'week' })).toBe('creator')
    expect(prefsToMode({ creators: false, keywords: true, timeframe: 'week' })).toBe('keyword')
  })

  it('returns null when nothing is selected — there is nothing to run', () => {
    expect(prefsToMode({ creators: false, keywords: false, timeframe: 'week' })).toBeNull()
  })
})
