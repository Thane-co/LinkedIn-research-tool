// Layer 2 — key/value settings store (PRD §6.4, §12 step 16). Low-level row access only.
// Seeding of non-secret defaults lives in db.ts (seedSettingsDefaults, called from migrate) so it
// can target the exact db being migrated without a db<->repo circular import.

import { getDb } from '@/lib/db/db'
import type { SettingsMap } from '@/lib/types'

/** Read all settings rows as a map (raw values — masking happens at the API layer). */
export function readAllSettings(): SettingsMap {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string | null
  }[]
  const map: SettingsMap = {}
  for (const { key, value } of rows) {
    map[key] = value ?? ''
  }
  return map
}

/** Upsert only the provided keys. Empty string is stored verbatim (an explicit "cleared" value). */
export function writeSettings(partial: SettingsMap): void {
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  const tx = getDb().transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) stmt.run(key, value)
  })
  tx(Object.entries(partial))
}
