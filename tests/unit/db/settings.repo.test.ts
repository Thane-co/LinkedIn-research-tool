import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { readAllSettings, writeSettings } from '@/lib/db/settings.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('settings.repo', () => {
  it('reads the seeded defaults as a map', () => {
    const all = readAllSettings()
    expect(all.apify_keyword_actor_id).toBe('harvestapi/linkedin-post-search')
    expect(all.default_market).toBe('ai')
  })

  it('upserts only the provided keys (partial write)', () => {
    writeSettings({ apify_api_token: 'tok_123' })
    const all = readAllSettings()
    expect(all.apify_api_token).toBe('tok_123')
    // untouched key still has its default
    expect(all.default_market).toBe('ai')
  })

  it('overwrites an existing value on repeated write', () => {
    writeSettings({ voyage_api_key: 'first' })
    writeSettings({ voyage_api_key: 'second' })
    expect(readAllSettings().voyage_api_key).toBe('second')
  })

  it('stores an empty string when a key is cleared', () => {
    writeSettings({ voyage_api_key: 'x' })
    writeSettings({ voyage_api_key: '' })
    expect(readAllSettings().voyage_api_key).toBe('')
  })
})
