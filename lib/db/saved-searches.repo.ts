// Layer 6 — saved filter presets (PRD §6.6, §11.6). Storage only. A saved search is a named
// snapshot of the Search filter row (params JSON) — NOT a stored result set.

import { getDb } from '@/lib/db/db'

export interface SavedSearchRow {
  id: string
  name: string
  params: string // JSON.stringify of the filter state
  created_at: string
}

export function createSavedSearch(name: string, params: unknown): SavedSearchRow {
  const row: SavedSearchRow = {
    id: crypto.randomUUID(),
    name,
    params: JSON.stringify(params),
    created_at: new Date().toISOString(),
  }
  getDb()
    .prepare('INSERT INTO saved_searches (id, name, params, created_at) VALUES (@id, @name, @params, @created_at)')
    .run(row)
  return row
}

/** Newest-first (rowid tiebreaker keeps ordering deterministic when created_at ties). */
export function listSavedSearches(): SavedSearchRow[] {
  return getDb()
    .prepare('SELECT id, name, params, created_at FROM saved_searches ORDER BY created_at DESC, rowid DESC')
    .all() as SavedSearchRow[]
}

export function deleteSavedSearch(id: string): void {
  getDb().prepare('DELETE FROM saved_searches WHERE id = ?').run(id)
}
