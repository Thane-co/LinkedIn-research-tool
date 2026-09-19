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
  { table: 'posts', column: 'transcript', type: 'TEXT' }, // §18 video transcript
  // §8 x-factor v2 — nullable, idempotent. `creator_baseline` is REPURPOSED (not added) to hold the
  // median-based creator level; the columns below are new.
  { table: 'posts', column: 'x_score', type: 'REAL' }, // the rarity z
  { table: 'posts', column: 'creator_spread', type: 'REAL' }, // spread in log units (debugging + tooltip)
  { table: 'posts', column: 'x_provisional', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'posts', column: 'measured_at', type: 'TEXT' }, // ISO instant the current counts came from
  { table: 'creators', column: 'persona', type: 'TEXT' }, // §17.2 cross-platform persona key
  // §21.8 follower-tracking opt-in. NOT NULL DEFAULT 0 is safe to add to an existing table: SQLite
  // backfills every existing row with the default, which is exactly the intent (opt-in, not opt-out).
  { table: 'creators', column: 'track_followers', type: 'INTEGER NOT NULL DEFAULT 0' },
]

/**
 * Schema version stamped into `PRAGMA user_version`, for migrations that DDL alone can't express.
 *   1 — posts_fts (§11.1): the index must be BACKFILLED for posts inserted before it existed.
 *   2 — follower_snapshots (§21): seed each already-scraped profile's follower count as the series'
 *       first data point, so the leaderboard has a baseline immediately instead of after 24h.
 *   3 — drop `creators.tier`. The core/watch split was never used (the PRD says v1 has one creator
 *       list) but the column outlived the idea, and 7 creators silently sat on 'watch' — which the
 *       default creator scrape filtered OUT. A dead column that quietly changes behaviour is worse
 *       than no column.
 * Bump this (and add a case to applyVersionedMigrations) whenever the search index must be rebuilt,
 * e.g. if the tokenizer or the indexed columns change.
 */
export const SCHEMA_VERSION = 3

/**
 * Data migrations that must run exactly once, gated on `user_version`. CREATE TABLE IF NOT EXISTS
 * gives an existing db an EMPTY posts_fts, and an empty index is indistinguishable from "nothing
 * matched" at query time — so the rebuild has to be driven by a version stamp, not by inspection.
 * The rebuild is O(corpus): ~3s for ~90k posts, once, on the first open after upgrading.
 */
function applyVersionedMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= SCHEMA_VERSION) return
  if (current < 1) {
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')")
  }
  if (current < 2) {
    // DO NOTHING, not DO UPDATE: a real capture always outranks a seed. `followers > 0` because a
    // profile that returned no count is missing data, and storing it as a measurement would invent
    // a crash on the seed day and a matching spike on the first real capture.
    db.exec(`INSERT INTO follower_snapshots (author_id, platform, captured_on, captured_at, followers, connections, source)
             SELECT id, 'linkedin', substr(scraped_at, 1, 10), scraped_at, followers, connections, 'seed'
             FROM profiles WHERE followers > 0
             ON CONFLICT(author_id, platform, captured_on) DO NOTHING`)
  }
  if (current < 3) {
    // Guarded: a fresh db created from the current schema.sql never had the column.
    const hasTier = (db.pragma('table_info(creators)') as { name: string }[]).some((c) => c.name === 'tier')
    if (hasTier) {
      db.exec('DROP INDEX IF EXISTS creators_tier_idx')
      db.exec('ALTER TABLE creators DROP COLUMN tier')
    }
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

/** Run the schema DDL idempotently against the given (or singleton) connection, then seed defaults. */
export function migrate(db?: Database.Database): void {
  const target = db ?? getDb()
  // WAL lets a reader run concurrently with a writer, which the read-only agent instance (§20.4)
  // depends on: it reads the same file while a scrape commits in the main instance. journal_mode is
  // a persistent property of the FILE, so this is a one-time upgrade for an existing db; an
  // in-memory db reports 'memory' and ignores it.
  target.pragma('journal_mode = WAL')
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
  // §8 x-factor v2 index on an additive column — created here (not schema.sql) so it also lands on a
  // legacy db whose posts table predates the x_score column.
  target.exec('CREATE INDEX IF NOT EXISTS posts_xscore_idx ON posts(x_score DESC)')
  applyVersionedMigrations(target)
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
