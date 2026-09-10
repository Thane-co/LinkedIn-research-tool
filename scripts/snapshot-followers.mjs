#!/usr/bin/env node
// Daily follower capture (§21) — the scheduled half of the champion leaderboard.
//
// WHY THIS SHELLS OUT TO THE APP INSTEAD OF DOING THE WORK ITSELF: the capture logic (actor batching,
// the 0-follower guard, the profiles refresh, the day-keyed upsert) lives in jobs/snapshot-followers.ts
// and is covered by tests. Reimplementing it here in plain JS would fork it, and the fork would drift
// silently. So this script drives the real route, starting a local server first if one is not already
// listening — which also keeps the "no cron, no scheduler INSIDE the app" rule intact: the schedule
// lives in launchd, the app stays a plain local server.
//
//   node scripts/snapshot-followers.mjs
//   node scripts/snapshot-followers.mjs --port 3000
//
// Scheduled daily via launchd — see docs/follower-tracking.md.

import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const PORT = portIdx !== -1 ? Number(args[portIdx + 1]) : 3000
const BASE = `http://127.0.0.1:${PORT}`
const READY_TIMEOUT_MS = 90_000

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)

async function isUp() {
  try {
    const res = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForReady(deadline) {
  while (Date.now() < deadline) {
    if (await isUp()) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

let started = null

async function ensureServer() {
  if (await isUp()) {
    log(`server already listening on ${PORT}`)
    return
  }
  log(`no server on ${PORT} — starting one`)
  started = spawn('npm', ['start', '--', '-p', String(PORT)], {
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: false,
    env: process.env,
  })
  started.on('error', (err) => {
    console.error(`failed to start the server: ${err.message}`)
    process.exit(1)
  })
  if (!(await waitForReady(Date.now() + READY_TIMEOUT_MS))) {
    console.error(`server did not become ready within ${READY_TIMEOUT_MS / 1000}s`)
    stopServer()
    process.exit(1)
  }
  log('server ready')
}

function stopServer() {
  if (started && !started.killed) {
    started.kill('SIGTERM')
    log('stopped the server this script started')
  }
}

async function main() {
  await ensureServer()

  // No Origin header, so the CSRF guard passes; a 412 means the Apify key is not set yet.
  const res = await fetch(`${BASE}/api/followers/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))

  if (res.status === 412) {
    console.error(`blocked: add ${(body.needs ?? []).join(', ')} in Settings first`)
    process.exitCode = 1
    return
  }
  if (!res.ok) {
    console.error(`capture failed (${res.status}): ${body.error ?? 'unknown error'}`)
    process.exitCode = 1
    return
  }

  log(
    `captured ${body.captured}/${body.requested} for ${body.captured_on} · ` +
      `${body.skipped?.length ?? 0} skipped · ${body.missing?.length ?? 0} missing · ` +
      `${body.errors?.length ?? 0} batch error(s)`,
  )
  if (body.missing?.length) log(`missing: ${body.missing.join(', ')}`)
  for (const e of body.errors ?? []) console.error(`batch error: ${e}`)
}

try {
  await main()
} finally {
  stopServer()
}
