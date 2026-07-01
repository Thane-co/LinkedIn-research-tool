// Layer 2 — better-sqlite3 singleton + migrate() (PRD §12 step 12).
// The schema (lib/db/schema.sql) is the source of truth for the DDL; migrate() applies it
// idempotently. Settings defaults are seeded here once seedSettingsDefaults exists (§6.4, step 16).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DB_PATH, SETTINGS_DEFAULTS } from '@/lib/config'

const schemaSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
  'utf8',
)

let instance: Database.Database | null = null

/**
 * Seed the non-secret settings defaults (PRD §6.4) with INSERT OR IGNORE so existing values and
 * user edits are never clobbered. Secret keys are intentionally NOT seeded — they start absent.
 * Co-located with migrate() (rather than settings.repo) to seed the exact target db and avoid a
 * db<->repo circular import.
 */
export function seedSettingsDefaults(db: Database.Database): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    stmt.run(key, value)
  }
}

/** Run the schema DDL idempotently against the given (or singleton) connection, then seed defaults. */
export function migrate(db?: Database.Database): void {
  const target = db ?? getDb()
  target.exec(schemaSql)
  seedSettingsDefaults(target)
}

/**
 * Return the process-wide connection. Passing an explicit path (e.g. ':memory:' in tests) closes
 * any current instance and opens a fresh, migrated connection as the new singleton.
 */
export function getDb(path?: string): Database.Database {
  if (path) {
    resetDb()
    instance = new Database(path)
    migrate(instance)
    return instance
  }
  if (!instance) {
    instance = new Database(DB_PATH)
    migrate(instance)
  }
  return instance
}

/** Close and clear the singleton (test isolation / graceful shutdown). */
export function resetDb(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}
