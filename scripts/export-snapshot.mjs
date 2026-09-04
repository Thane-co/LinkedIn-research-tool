#!/usr/bin/env node
// Build a deployable, read-only snapshot of the corpus (PRD §20.5).
//
//   npm run snapshot                  # -> ./snapshot.db
//   npm run snapshot -- ./out.db      # explicit path
//   npm run snapshot -- --token <t>   # reuse an existing remote token instead of minting one
//
// What it deliberately does NOT copy:
//   * posts.raw_data / profiles.raw_data — the unfiltered actor payloads. 315MB of the 616MB, and
//     the API strips them from every response anyway, so they have no reason to leave this machine.
//   * the settings table — it holds your Apify / Voyage / Anthropic / AssemblyAI keys. The snapshot
//     gets ONE setting: a freshly minted read-only token, separate from your local one, so revoking
//     either side never touches the other. A host with no keys cannot scrape even in principle.
//   * scrape_jobs — job history no /api/v1 endpoint reads.
//
// The schema is copied from the SOURCE database's own sqlite_master rather than from schema.sql, so
// the snapshot can never drift from whatever migrations the live db has actually had applied.

import { randomBytes } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { loadDatabase } from './_load-sqlite.mjs'

const Database = await loadDatabase()

const args = process.argv.slice(2)
const tokenFlag = args.indexOf('--token')
const providedToken = tokenFlag !== -1 ? args[tokenFlag + 1] : null
// Skip the value that belongs to --token, but only when --token was actually passed: with
// tokenFlag === -1, `tokenFlag + 1` is 0 and would swallow the first positional argument.
const tokenValueIndex = tokenFlag === -1 ? -1 : tokenFlag + 1
const outPath = args.find((a, i) => !a.startsWith('--') && i !== tokenValueIndex) ?? './snapshot.db'
const srcPath = process.env.DB_PATH ?? './research.db'

if (!existsSync(srcPath)) {
  console.error(`No database at ${srcPath}.`)
  process.exit(1)
}
if (providedToken !== null && (!providedToken || providedToken.startsWith('--'))) {
  console.error('--token needs a value.')
  process.exit(1)
}

// Tables the snapshot carries, and the columns blanked on the way out.
const COPY = [
  { table: 'posts', blank: ['raw_data'] },
  { table: 'profiles', blank: ['raw_data'] },
  { table: 'creators', blank: [] },
  { table: 'keywords', blank: [] },
]
const SKIP_TABLES = new Set(['settings', 'scrape_jobs'])

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(outPath + suffix)) unlinkSync(outPath + suffix)
}

const src = new Database(srcPath, { readonly: true, fileMustExist: true })
const out = new Database(outPath)

// 1. Recreate the schema exactly as it exists in the source (tables first, then indexes).
const objects = src
  .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
  .all()
const wanted = (name) => !SKIP_TABLES.has(name)
for (const kind of ['table', 'index']) {
  for (const o of objects) {
    if (o.type !== kind) continue
    // An index on a skipped table would fail to create; the settings table is recreated below.
    if (kind === 'table' && !wanted(o.name) && o.name !== 'settings') continue
    if (kind === 'index' && SKIP_TABLES.has(o.tbl_name ?? '')) continue
    try {
      out.exec(o.sql)
    } catch (err) {
      if (!/already exists/i.test(err.message)) throw err
    }
  }
}
// settings is recreated (schema only) so the token has somewhere to live; its ROWS are never copied.
if (!out.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
  out.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
}

// 2. Copy the rows, blanking the raw payload columns.
out.exec(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS src`)
out.pragma('journal_mode = WAL')

const counts = {}
const copy = out.transaction(() => {
  for (const { table, blank } of COPY) {
    const cols = out.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    const select = cols.map((c) => (blank.includes(c) ? `NULL AS ${c}` : c)).join(', ')
    out.exec(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${select} FROM src.${table}`)
    counts[table] = out.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n
  }
})
copy()
out.exec('DETACH DATABASE src')

// 3. The one setting the snapshot carries: its own read-only token.
const token = providedToken ?? randomBytes(32).toString('hex')
out.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('readonly_api_token', token)

// 4. Compact, then verify nothing sensitive rode along.
out.exec('VACUUM')
const leaked = out
  .prepare("SELECT key FROM settings WHERE key <> 'readonly_api_token'")
  .all()
  .map((r) => r.key)
if (leaked.length > 0) {
  console.error(`REFUSING TO SHIP: snapshot carries extra settings: ${leaked.join(', ')}`)
  process.exit(1)
}
const rawLeft = out.prepare("SELECT COUNT(*) n FROM posts WHERE raw_data IS NOT NULL").get().n
if (rawLeft > 0) {
  console.error(`REFUSING TO SHIP: ${rawLeft} posts still carry raw_data.`)
  process.exit(1)
}
out.close()
src.close()

const size = statSync(outPath).size
console.log(`Snapshot written to ${outPath} (${mb(size)}), down from ${mb(statSync(srcPath).size)}.\n`)
for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(10)} ${n.toLocaleString()} rows`)
console.log('\n  raw_data      stripped')
console.log('  API keys      NOT included (settings holds only the remote token)')
console.log(`\nRemote read-only token (separate from your local one):\n\n  ${token}\n`)
console.log('Copy it to the VPS and run the API there:\n')
console.log(`  scp ${outPath} user@your-vps:/srv/research-api/snapshot.db`)
console.log('  # on the VPS, in the app directory:')
console.log('  DB_PATH=/srv/research-api/snapshot.db READONLY_SERVER=1 npm run start:agent\n')
