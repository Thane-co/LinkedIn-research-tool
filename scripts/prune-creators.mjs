#!/usr/bin/env node
// Creator-roster maintenance (one-off, safe to re-run).
//
// Two jobs, in order:
//   1. BACKFILL author_id  — 35 LinkedIn creator rows carry a NULL author_id, so every
//      creators -> posts join (x-factor views, the follower leaderboard) silently drops them
//      even though they are scraped daily. The clean slug is already sitting in profile_url.
//   2. PRUNE inactive      — delete LinkedIn creators with no post in the last N days (default 90).
//      Deleting a creator removes them from the SCRAPE SET only: `posts` has no foreign key to
//      `creators`, so every post they ever wrote stays in the corpus and stays searchable.
//
// Deleted rows are written to a timestamped JSON file first, so a prune is fully reversible.
//
//   node scripts/prune-creators.mjs              # dry run, prints what would change
//   node scripts/prune-creators.mjs --apply      # write the changes
//   node scripts/prune-creators.mjs --days 120   # different inactivity window

import { writeFileSync } from 'node:fs'
import { loadDatabase } from './_load-sqlite.mjs'

const Database = await loadDatabase()
const DB_PATH = process.env.DB_PATH ?? './research.db'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const daysIdx = args.indexOf('--days')
const DAYS = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 90

const db = new Database(DB_PATH)

/**
 * The clean public identifier out of a LinkedIn profile url — the same "match on the slug, never
 * the url" invariant the post pipeline holds. Percent-decodes (some rows carry emoji slugs) and
 * returns null when the url has no /in/ segment at all.
 */
function slugFromUrl(url) {
  if (!url) return null
  const m = /\/in\/([^/?#]+)/.exec(url)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

// --- 1. backfill author_id -------------------------------------------------
const missing = db
  .prepare(`SELECT id, display_name, profile_url FROM creators WHERE platform='linkedin' AND (author_id IS NULL OR author_id='')`)
  .all()

const fixes = []
const unfixable = []
for (const c of missing) {
  const slug = slugFromUrl(c.profile_url)
  if (slug) fixes.push({ ...c, slug })
  else unfixable.push(c)
}

console.log(`\nBACKFILL author_id — ${missing.length} rows missing, ${fixes.length} derivable\n`)
for (const f of fixes) console.log(`  ${(f.display_name ?? '(no name)').padEnd(28)} -> ${f.slug}`)
if (unfixable.length) {
  console.log(`\n  NOT derivable (no /in/ segment), left untouched:`)
  for (const u of unfixable) console.log(`    ${u.display_name ?? '(no name)'}  ${u.profile_url}`)
}

// --- 2. prune inactive -----------------------------------------------------
// Runs against the POST-backfill slug so a NULL author_id is never mistaken for inactivity.
const all = db.prepare(`SELECT * FROM creators WHERE platform='linkedin'`).all()
const lastPost = db.prepare(
  `SELECT COUNT(*) AS n, MAX(substr(posted_at,1,10)) AS last FROM posts WHERE platform='linkedin' AND author_id = ?`,
)
const recent = db.prepare(
  `SELECT COUNT(*) AS n FROM posts WHERE platform='linkedin' AND author_id = ? AND posted_at >= date('now', ?)`,
)

const doomed = []
const kept = []
for (const c of all) {
  const slug = c.author_id && c.author_id !== '' ? c.author_id : slugFromUrl(c.profile_url)
  const activity = slug ? recent.get(slug, `-${DAYS} day`).n : 0
  const hist = slug ? lastPost.get(slug) : { n: 0, last: null }
  const entry = { ...c, slug, total_posts: hist.n, last_post: hist.last, recent_posts: activity }
  if (activity > 0) kept.push(entry)
  else doomed.push(entry)
}

doomed.sort((a, b) => (b.last_post ?? '').localeCompare(a.last_post ?? ''))

console.log(`\nPRUNE — no LinkedIn post in the last ${DAYS} days\n`)
console.log(`  keeping ${kept.length}, deleting ${doomed.length}\n`)
for (const d of doomed) {
  console.log(
    `  ${(d.display_name ?? '(no name)').padEnd(30)} ${String(d.total_posts).padStart(4)} posts   last ${d.last_post ?? 'never'}`,
  )
}

const daily = kept.length * 0.004
console.log(`\n  follower snapshots after prune: ${kept.length}/day = $${daily.toFixed(2)}/day = $${(daily * 30).toFixed(2)}/month`)

if (!apply) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to commit.\n`)
  process.exit(0)
}

// --- write -----------------------------------------------------------------
const stamp = new Date().toISOString().slice(0, 10)
const backup = `./pruned-creators-${stamp}.json`
writeFileSync(backup, JSON.stringify(doomed, null, 2))

const setAuthorId = db.prepare(`UPDATE creators SET author_id = ?, updated_at = ? WHERE id = ?`)
const del = db.prepare(`DELETE FROM creators WHERE id = ?`)
const now = new Date().toISOString()

const run = db.transaction(() => {
  for (const f of fixes) setAuthorId.run(f.slug, now, f.id)
  for (const d of doomed) del.run(d.id)
})
run()

console.log(`\nAPPLIED`)
console.log(`  author_id backfilled: ${fixes.length}`)
console.log(`  creators deleted:     ${doomed.length}  (posts kept; backup -> ${backup})`)
console.log(`  creators remaining:   ${db.prepare(`SELECT COUNT(*) AS n FROM creators WHERE platform='linkedin'`).get().n}\n`)
