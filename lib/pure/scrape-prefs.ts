// Layer 0 — per-platform scrape preferences (PRD §11.8). Zero I/O.
//
// Each platform is scraped on its own terms: its own source toggles, its own timeframe, and its own
// actor-specific option (a likes floor on Twitter, Notes on Substack). These live in one `scrape_prefs`
// settings row as JSON; this module is the only place that shape is defined, parsed, or defaulted.
//
// Parsing is deliberately TOLERANT: a hand-edited or older settings row must never throw at startup
// and never leave a platform undefined — an unknown value falls back to its default.

import type { Platform, ScrapeMode, Timeframe } from '@/lib/types'

export interface PlatformPrefs {
  creators: boolean
  keywords: boolean
  timeframe: Timeframe
  /** Twitter only — `minimumFavorites` on the actor, applied by X's search index BEFORE billing. */
  minimumFavorites?: number
  /** Substack only — also pull the Notes feed (§17). Roughly doubles the work. */
  includeNotes?: boolean
}

export type ScrapePrefs = Record<Platform, PlatformPrefs>

export const PLATFORMS: readonly Platform[] = ['linkedin', 'twitter', 'substack', 'instagram'] as const

/** apify/instagram-post-scraper is profile-driven — there is no keyword mode to offer (§18). */
export const PLATFORM_SUPPORTS_KEYWORDS: Record<Platform, boolean> = {
  linkedin: true,
  twitter: true,
  substack: true,
  instagram: false,
}

const TIMEFRAMES: readonly Timeframe[] = ['all', '24h', '3d', 'week', 'month', '3months', 'custom'] as const

export const DEFAULT_SCRAPE_PREFS: ScrapePrefs = {
  linkedin: { creators: true, keywords: true, timeframe: 'week' },
  // 250 is a floor, not a ceiling: X filters on it server-side so the run returns (and bills for)
  // fewer, better tweets. Before this, ~20% of every pull was under 100 likes.
  twitter: { creators: true, keywords: true, timeframe: 'week', minimumFavorites: 250 },
  substack: { creators: true, keywords: true, timeframe: 'week', includeNotes: false },
  instagram: { creators: true, keywords: false, timeframe: 'week' },
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const timeframe = (v: unknown, fallback: Timeframe): Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v) ? (v as Timeframe) : fallback

/** A likes floor is only meaningful above zero; anything else means "no floor" (omit the field). */
const floor = (v: unknown, fallback: number | undefined): number | undefined => {
  if (v === undefined) return fallback
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

/** Merge one stored platform object over its defaults, dropping anything unrecognized. */
function mergeOne(platform: Platform, stored: unknown): PlatformPrefs {
  const base = DEFAULT_SCRAPE_PREFS[platform]
  if (!isRecord(stored)) return { ...base }
  const merged: PlatformPrefs = {
    creators: bool(stored.creators, base.creators),
    // A platform with no keyword mode can never be switched on, whatever the stored row says.
    keywords: PLATFORM_SUPPORTS_KEYWORDS[platform] ? bool(stored.keywords, base.keywords) : false,
    timeframe: timeframe(stored.timeframe, base.timeframe),
  }
  const favs = floor(stored.minimumFavorites, base.minimumFavorites)
  if (favs !== undefined) merged.minimumFavorites = favs
  if (base.includeNotes !== undefined) merged.includeNotes = bool(stored.includeNotes, base.includeNotes)
  return merged
}

/** Parse the stored `scrape_prefs` JSON into a complete, valid prefs map. Never throws. */
export function parseScrapePrefs(raw: string | null | undefined): ScrapePrefs {
  let parsed: unknown = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null // a malformed row falls back to defaults rather than breaking the settings screen
    }
  }
  const source = isRecord(parsed) ? parsed : {}
  return {
    linkedin: mergeOne('linkedin', source.linkedin),
    twitter: mergeOne('twitter', source.twitter),
    substack: mergeOne('substack', source.substack),
    instagram: mergeOne('instagram', source.instagram),
  }
}

export function serializeScrapePrefs(prefs: ScrapePrefs): string {
  return JSON.stringify(prefs)
}

/** The scrape mode implied by the two source toggles, or null when neither is on (nothing to run). */
export function prefsToMode(prefs: PlatformPrefs): ScrapeMode | null {
  if (prefs.creators && prefs.keywords) return 'both'
  if (prefs.creators) return 'creator'
  if (prefs.keywords) return 'keyword'
  return null
}
