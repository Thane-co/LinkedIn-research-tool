import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb, migrate, resetDb, SCHEMA_VERSION } from '@/lib/db/db'
import { SETTINGS_DEFAULTS } from '@/lib/config'

afterEach(() => resetDb())

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name)
    .sort()

// The six real tables, excluding FTS5's virtual table and its `posts_fts_*` shadow tables.
const contentTableNames = (db: Database.Database): string[] =>
  tableNames(db).filter((n) => !n.startsWith('posts_fts'))

const indexNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string
  }[]).map((r) => r.name)

describe('migrate', () => {
  it('creates all eight content tables', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(contentTableNames(db)).toEqual([
      'creators', 'follower_snapshots', 'keywords', 'post_snapshots', 'posts', 'profiles',
      'scrape_jobs', 'settings',
    ])
  })

  it('creates the posts_fts search index and its sync triggers (§11.1)', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(tableNames(db)).toContain('posts_fts')
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(triggers).toEqual(
      expect.arrayContaining(['posts_fts_insert', 'posts_fts_delete', 'posts_fts_update']),
    )
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
    expect(contentTableNames(db)).toEqual([
      'creators', 'follower_snapshots', 'keywords', 'post_snapshots', 'posts', 'profiles',
      'scrape_jobs', 'settings',
    ])
  })

  it('seeds the follower series from profiles already scraped (§21), once, without clobbering a real capture', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare(
      "INSERT INTO profiles (id, followers, connections, scraped_at) VALUES ('jane', 12000, 500, '2026-08-01T09:30:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO profiles (id, followers, connections, scraped_at) VALUES ('ghost', 0, 0, '2026-08-01T09:30:00.000Z')",
    ).run()

    // Re-run the versioned migration as it would run on the next open of an older db.
    db.pragma('user_version = 1')
    migrate(db)

    const rows = db.prepare('SELECT author_id, followers, source FROM follower_snapshots').all()
    expect(rows).toEqual([{ author_id: 'jane', followers: 12000, source: 'seed' }])
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
      display_name TEXT, avatar_url TEXT,
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

describe('migrate — posts_fts backfill (schema version 1)', () => {
  /** A db holding posts but no search index: what every pre-FTS database looks like on first open. */
  const legacyDbWithPosts = (): Database.Database => {
    const db = new Database(':memory:')
    migrate(db) // real schema, so the columns match
    db.prepare("INSERT INTO posts (id, platform, content, scraped_at) VALUES (?, 'linkedin', ?, 't')").run(
      'a',
      'ai agents everywhere',
    )
    // Wipe the index and the version stamp to simulate a db created before posts_fts existed.
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('delete-all')")
    db.pragma('user_version = 0')
    return db
  }

  it('backfills the index for posts that were inserted before it existed', () => {
    const db = legacyDbWithPosts()
    const matches = (): number =>
      (db.prepare("SELECT COUNT(*) AS n FROM posts_fts WHERE posts_fts MATCH 'agents'").get() as { n: number }).n
    expect(matches()).toBe(0) // precondition: the index really is empty

    migrate(db)
    expect(matches()).toBe(1)
  })

  it('stamps the schema version so the rebuild runs once, not on every open', () => {
    const db = legacyDbWithPosts()
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)

    // A second migrate must NOT rebuild: prove it by emptying the index and re-running.
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('delete-all')")
    migrate(db)
    const n = (db.prepare("SELECT COUNT(*) AS n FROM posts_fts WHERE posts_fts MATCH 'agents'").get() as {
      n: number
    }).n
    expect(n).toBe(0)
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
