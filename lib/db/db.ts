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

// Additive column migrations for databases created before a column existed. `CREATE TABLE IF NOT
// EXISTS` never alters an existing table, so new nullable columns are added here idempotently.
const ADDITIVE_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'posts', column: 'media', type: 'TEXT' }, // §10.3.1 post media
  { table: 'creators', column: 'persona', type: 'TEXT' }, // §17.2 cross-platform persona key
]

/** Run the schema DDL idempotently against the given (or singleton) connection, then seed defaults. */
export function migrate(db?: Database.Database): void {
  const target = db ?? getDb()
  target.exec(schemaSql)
  for (const { table, column, type } of ADDITIVE_COLUMNS) {
    try {
      target.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    } catch {
      // column already exists — the fresh schema created it, or a prior migrate added it
    }
  }
  // Indexes on additive columns run here (not in schema.sql) so the column is guaranteed to exist on
  // a legacy db that predates it (§17.2 persona).
  target.exec('CREATE INDEX IF NOT EXISTS creators_persona_idx ON creators(persona)')
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
