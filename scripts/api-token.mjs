#!/usr/bin/env node
// Create / show / rotate the read-only API token (PRD §20).
//
//   npm run api:token            # print the token, creating one on first run
//   npm run api:token -- --show  # print it, never create
//   npm run api:token -- --rotate# replace it (any agent holding the old one is cut off)
//   npm run api:token -- --revoke# clear it, turning the read-only API off
//
// The token lives in the same local `settings` table as your API keys — never in code, never in git.

import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'

const KEY = 'readonly_api_token'
const DB_PATH = process.env.DB_PATH ?? './research.db'
const args = new Set(process.argv.slice(2))

let db
try {
  db = new Database(DB_PATH, { fileMustExist: true })
} catch (err) {
  // Only a genuinely absent file gets the friendly hint — anything else (a native-module/Node
  // version mismatch, a permissions problem) must surface as itself, not be mislabelled.
  if (/unable to open database file|ENOENT/i.test(err.message)) {
    console.error(`No database at ${DB_PATH}. Start the app once (npm run dev) to create it, then rerun.`)
    process.exit(1)
  }
  throw err
}

const read = () => db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY)?.value || null
const write = (value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, value)

if (args.has('--revoke')) {
  write('')
  console.log('Read-only API token cleared. /api/v1 now returns 503 until you create a new one.')
  process.exit(0)
}

// Rotate FIRST: `--rotate --show` must print the new token, not return the old one and skip the
// rotation. --show alone never creates.
let token = read()
const rotating = args.has('--rotate')
if (rotating || (!token && !args.has('--show'))) {
  token = randomBytes(32).toString('hex')
  write(token)
  if (!args.has('--show')) console.log(rotating ? 'Token rotated.\n' : 'Token created.\n')
}

if (args.has('--show')) {
  // stdout carries the token and NOTHING else, so `TOKEN=$(npm run --silent api:token -- --show)`
  // can never capture prose as a token. No token = empty stdout + a message on stderr + exit 1.
  if (!token) {
    console.error('No read-only API token set. Run `npm run api:token` to create one.')
    process.exit(1)
  }
  console.log(token)
  process.exit(0)
}

const port = process.env.PORT ?? '3000'
console.log(`Read-only API token:\n\n  ${token}\n`)
console.log('Give your agent this base url + token (the app must be running):\n')
console.log(`  BASE_URL=http://127.0.0.1:${port}/api/v1`)
console.log(`  Authorization: Bearer ${token}\n`)
console.log('Smoke test:\n')
console.log(`  curl -s -H "Authorization: Bearer ${token}" http://127.0.0.1:${port}/api/v1/stats\n`)
