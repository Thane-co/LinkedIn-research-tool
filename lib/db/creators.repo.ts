// Layer 2 — creator CRUD (PRD §11.2, §12 step 14).
// Storage only: platform detection / url normalization / author_id derivation happen at the route
// layer (using lib/pure/url.ts). Every creator here IS the scrape set — there is no tier/watch split.
// Re-adding an existing creator is idempotent: it updates the display fields, never duplicates.

import { getDb } from '@/lib/db/db'
import { derivePersonaKey } from '@/lib/pure/persona'
import type { CreatorRow, Platform } from '@/lib/types'

export interface NewCreator {
  platform: Platform
  profile_url: string
  author_id?: string | null
  display_name?: string | null
  avatar_url?: string | null
  persona?: string | null
  tags?: string[]
  market?: string
  notes?: string | null
}

const COLUMNS = `id, platform, profile_url, author_id, display_name, avatar_url, persona, track_followers, tags, market, notes, added_at, updated_at`

function getByUrl(profileUrl: string): CreatorRow | undefined {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM creators WHERE profile_url = ?`)
    .get(profileUrl) as CreatorRow | undefined
}

/** Insert a new creator, or enrich an existing one (matched by profile_url). Idempotent re-add. */
export function upsertCreator(creator: NewCreator): CreatorRow {
  const db = getDb()
  const now = new Date().toISOString()
  const existing = getByUrl(creator.profile_url)

  if (existing) {
    // Fill in any newly-provided display fields. persona
    // COALESCEs so a provided value (auto-derived or a manual override) wins and an omitted one
    // preserves the existing label (§17.2).
    db.prepare(
      `UPDATE creators SET
         display_name = COALESCE(?, display_name),
         avatar_url   = COALESCE(?, avatar_url),
         author_id    = COALESCE(?, author_id),
         persona      = COALESCE(?, persona),
         updated_at   = ?
       WHERE profile_url = ?`,
    ).run(
      creator.display_name ?? null,
      creator.avatar_url ?? null,
      creator.author_id ?? null,
      creator.persona ?? null,
      now,
      creator.profile_url,
    )
    return getByUrl(creator.profile_url)!
  }

  const row: CreatorRow = {
    id: crypto.randomUUID(),
    platform: creator.platform,
    profile_url: creator.profile_url,
    author_id: creator.author_id ?? null,
    display_name: creator.display_name ?? null,
    avatar_url: creator.avatar_url ?? null,
    persona: creator.persona ?? null,
    // §21.8 — opt-in. A creator added for content research must never start costing a daily call.
    track_followers: 0,
    tags: JSON.stringify(creator.tags ?? []),
    market: creator.market ?? 'ai',
    notes: creator.notes ?? null,
    added_at: now,
    updated_at: now,
  }
  db.prepare(
    `INSERT INTO creators (${COLUMNS}) VALUES
     (@id, @platform, @profile_url, @author_id, @display_name, @avatar_url, @persona, @track_followers, @tags, @market, @notes, @added_at, @updated_at)`,
  ).run(row)
  return row
}

export function listCreators(filter?: {
  tag?: string
  platform?: Platform
  /** §21.8 — narrow to the follower-tracking subset. Omit for the full scrape roster. */
  tracked?: boolean
}): { creators: CreatorRow[]; tags: string[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter?.platform) {
    conditions.push('platform = ?')
    params.push(filter.platform)
  }
  if (filter?.tracked !== undefined) {
    conditions.push('track_followers = ?')
    params.push(filter.tracked ? 1 : 0)
  }
  if (filter?.tag) {
    conditions.push('tags LIKE ?')
    params.push(`%"${filter.tag}"%`)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const creators = getDb()
    .prepare(`SELECT ${COLUMNS} FROM creators ${where} ORDER BY added_at DESC`)
    .all(...params) as CreatorRow[]

  // Distinct tags across ALL creators (unfiltered), for the filter dropdown. A corrupt tags value on
  // one row must never take down the whole list — log it and skip, don't throw (no silent failures).
  const allTagRows = getDb().prepare('SELECT id, tags FROM creators').all() as { id: string; tags: string }[]
  const tagSet = new Set<string>()
  for (const { id, tags } of allTagRows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(tags)
    } catch {
      console.error(`listCreators: skipping corrupt tags JSON on creator ${id}`)
      continue
    }
    if (Array.isArray(parsed)) for (const t of parsed) if (typeof t === 'string') tagSet.add(t)
  }

  return { creators, tags: [...tagSet] }
}

/**
 * Turn the daily follower capture on or off for one creator (§21.8). Returns the updated row, or
 * null when no such creator exists — a silent no-op would let the UI show a toggle that does nothing.
 *
 * Note what this does NOT touch: the scrape roster. Untracking a creator keeps scraping their posts
 * for research; it only removes them from the daily profile call and the champion leaderboard.
 */
export function setCreatorTracking(id: string, tracked: boolean): CreatorRow | null {
  const db = getDb()
  const res = db
    .prepare('UPDATE creators SET track_followers = ?, updated_at = ? WHERE id = ?')
    .run(tracked ? 1 : 0, new Date().toISOString(), id)
  if (res.changes === 0) return null
  return (db.prepare(`SELECT ${COLUMNS} FROM creators WHERE id = ?`).get(id) as CreatorRow) ?? null
}

export function deleteCreator(id: string): void {
  getDb().prepare('DELETE FROM creators WHERE id = ?').run(id)
}

/**
 * Fill `persona` from display_name for every creator that has none (PRD §11.8, §17.2). This is what
 * turns the flat account list into a person-per-row table: two accounts whose names normalize to the
 * same key become one person. Only ever writes a NULL persona — a manual override is never clobbered,
 * and a name that yields no key (blank, punctuation-only) is left alone rather than guessed at.
 * Idempotent: running it twice reports 0 updated.
 */
export function backfillPersonas(): { updated: number } {
  const db = getDb()
  const rows = db
    .prepare("SELECT id, display_name FROM creators WHERE persona IS NULL OR persona = ''")
    .all() as { id: string; display_name: string | null }[]

  const now = new Date().toISOString()
  const stmt = db.prepare('UPDATE creators SET persona = ?, updated_at = ? WHERE id = ?')
  let updated = 0
  const tx = db.transaction(() => {
    for (const { id, display_name } of rows) {
      const key = derivePersonaKey(display_name)
      if (!key) continue
      stmt.run(key, now, id)
      updated += 1
    }
  })
  tx()
  return { updated }
}
