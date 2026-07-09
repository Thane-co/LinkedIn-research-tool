import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb, migrate, resetDb } from '@/lib/db/db'
import { SETTINGS_DEFAULTS } from '@/lib/config'

afterEach(() => resetDb())

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name)
    .sort()

const indexNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string
  }[]).map((r) => r.name)

describe('migrate', () => {
  it('creates all five tables', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(tableNames(db)).toEqual(['creators', 'keywords', 'posts', 'scrape_jobs', 'settings'])
  })

  it('creates the load-bearing indexes (including the unique url index)', () => {
    const db = new Database(':memory:')
    migrate(db)
    const idx = indexNames(db)
    expect(idx).toContain('posts_author_posted_idx')
    expect(idx).toContain('posts_url_unique_idx')
    expect(idx).toContain('scrape_jobs_started_idx')
  })

  it('enforces the unique url index (dedup safety net)', () => {
    const db = new Database(':memory:')
    migrate(db)
    const insert = db.prepare(
      "INSERT INTO posts (id, platform, url, scraped_at) VALUES (?, 'linkedin', ?, ?)",
    )
    insert.run('a', 'https://x/1', '2026-06-01T00:00:00.000Z')
    expect(() => insert.run('b', 'https://x/1', '2026-06-01T00:00:00.000Z')).toThrow()
  })

  it('is idempotent (running twice does not throw)', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(tableNames(db)).toEqual(['creators', 'keywords', 'posts', 'scrape_jobs', 'settings'])
  })

  it('seeds the non-secret settings defaults', () => {
    const db = new Database(':memory:')
    migrate(db)
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'apify_keyword_actor_id'")
      .get() as { value: string } | undefined
    expect(row?.value).toBe(SETTINGS_DEFAULTS.apify_keyword_actor_id)
  })

  it('does not overwrite an existing setting on re-migrate', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare("UPDATE settings SET value = 'custom/actor' WHERE key = 'apify_keyword_actor_id'").run()
    migrate(db) // re-run
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'apify_keyword_actor_id'")
      .get() as { value: string }
    expect(row.value).toBe('custom/actor')
  })

  it('does not seed secret keys (they start absent)', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(db.prepare("SELECT value FROM settings WHERE key = 'apify_api_token'").get()).toBeUndefined()
  })

  it('migrates a legacy creators table (no persona column) additively without error (§17.2)', () => {
    // Simulate a db created before the persona column: a minimal legacy creators table.
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE creators (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, profile_url TEXT NOT NULL, author_id TEXT,
      display_name TEXT, avatar_url TEXT, tier TEXT NOT NULL DEFAULT 'core',
      tags TEXT NOT NULL DEFAULT '[]', market TEXT NOT NULL DEFAULT 'ai', notes TEXT,
      added_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_url)
    )`)
    db.prepare(
      "INSERT INTO creators (id, platform, profile_url, added_at, updated_at) VALUES ('c1','linkedin','https://li/x','t','t')",
    ).run()

    // The persona index must be created AFTER the ALTER adds the column, or this would throw.
    expect(() => migrate(db)).not.toThrow()
    const cols = (db.prepare('PRAGMA table_info(creators)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('persona')
    expect(indexNames(db)).toContain('creators_persona_idx')
    // the pre-existing row survives with a null persona
    expect(db.prepare("SELECT persona FROM creators WHERE id='c1'").get()).toEqual({ persona: null })
    expect(() => migrate(db)).not.toThrow() // still idempotent
  })
})

describe('getDb', () => {
  it('returns a migrated singleton; repeated calls return the same instance', () => {
    const db = getDb(':memory:')
    expect(tableNames(db)).toContain('posts')
    expect(getDb()).toBe(db)
  })

  it('reopens a fresh db when an explicit path is passed', () => {
    const first = getDb(':memory:')
    first.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run()
    const second = getDb(':memory:') // new connection
    expect(second).not.toBe(first)
    expect(second.prepare("SELECT value FROM settings WHERE key='k'").get()).toBeUndefined()
  })
})
