// Layer 2 — creator CRUD (PRD §11.2, §12 step 14).
// Storage only: platform detection / url normalization / author_id derivation happen at the route
// layer (using lib/pure/url.ts). Every creator is 'core' (the scrape set); re-adding an existing
// creator is idempotent — it updates the display fields and never creates a duplicate.

import { getDb } from '@/lib/db/db'
import type { CreatorRow, CreatorTier, Platform } from '@/lib/types'

export interface NewCreator {
  platform: Platform
  profile_url: string
  author_id?: string | null
  display_name?: string | null
  avatar_url?: string | null
  tier?: CreatorTier
  tags?: string[]
  market?: string
  notes?: string | null
}

const COLUMNS = `id, platform, profile_url, author_id, display_name, avatar_url, tier, tags, market, notes, added_at, updated_at`

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
    // Keep it in the scrape set (tier 'core'); fill in any newly-provided display fields.
    db.prepare(
      `UPDATE creators SET tier = 'core',
         display_name = COALESCE(?, display_name),
         avatar_url   = COALESCE(?, avatar_url),
         author_id    = COALESCE(?, author_id),
         updated_at   = ?
       WHERE profile_url = ?`,
    ).run(
      creator.display_name ?? null,
      creator.avatar_url ?? null,
      creator.author_id ?? null,
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
    tier: creator.tier ?? 'core',
    tags: JSON.stringify(creator.tags ?? []),
    market: creator.market ?? 'ai',
    notes: creator.notes ?? null,
    added_at: now,
    updated_at: now,
  }
  db.prepare(
    `INSERT INTO creators (${COLUMNS}) VALUES
     (@id, @platform, @profile_url, @author_id, @display_name, @avatar_url, @tier, @tags, @market, @notes, @added_at, @updated_at)`,
  ).run(row)
  return row
}

export function listCreators(filter?: {
  tier?: CreatorTier
  tag?: string
  platform?: Platform
}): { creators: CreatorRow[]; tags: string[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter?.tier) {
    conditions.push('tier = ?')
    params.push(filter.tier)
  }
  if (filter?.platform) {
    conditions.push('platform = ?')
    params.push(filter.platform)
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

export function deleteCreator(id: string): void {
  getDb().prepare('DELETE FROM creators WHERE id = ?').run(id)
}
