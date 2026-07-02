import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { getKey, readiness, setSettings } from '@/lib/settings'

let dir: string | null = null
afterEach(() => {
  resetDb()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('BYO API keys persist across restarts', () => {
  it('a saved key survives closing and reopening the same db file (no re-entry)', () => {
    dir = mkdtempSync(join(tmpdir(), 'research-persist-'))
    const dbPath = join(dir, 'research.db')

    // "First launch": fresh db file on disk, user pastes their keys.
    getDb(dbPath)
    setSettings({ apify_api_token: 'user-secret-123', voyage_api_key: 'vk-abc' })
    resetDb() // app quits — connection released, the file stays on disk

    // "Next launch": reopen the SAME file (as the app does via DB_PATH) — keys are still there.
    getDb(dbPath)
    expect(getKey('apify_api_token')).toBe('user-secret-123')
    expect(getKey('voyage_api_key')).toBe('vk-abc')
    expect(readiness()).toMatchObject({ apify: true, voyage: true })
    expect(existsSync(dbPath)).toBe(true) // the db file persisted
  })
})
