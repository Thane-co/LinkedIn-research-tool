// Layer 2 — better-sqlite3 singleton + migrate() (PRD §12 step 12).
// TDD: open :memory: db, migrate(), assert tables/indexes exist. Real SQLite in tests (not a mock).

import type BetterSqlite3 from 'better-sqlite3'

/** Return the process-wide better-sqlite3 connection (opened at DB_PATH, or an override for tests). */
export function getDb(_path?: string): BetterSqlite3.Database {
  throw new Error('Not implemented — see PRD §12 step 12')
}

/** Run schema.sql idempotently and seed non-secret settings defaults (PRD §6.4). */
export function migrate(_db?: BetterSqlite3.Database): void {
  throw new Error('Not implemented — see PRD §12 step 12')
}
