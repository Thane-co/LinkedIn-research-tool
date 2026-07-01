import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { getKey, getSettings, readiness, setSettings } from '@/lib/settings'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('getSettings', () => {
  it('merges defaults under stored rows (stored wins)', () => {
    setSettings({ apify_keyword_actor_id: 'custom/actor', apify_api_token: 'tok' })
    const s = getSettings()
    expect(s.apify_keyword_actor_id).toBe('custom/actor') // stored overrides default
    expect(s.default_market).toBe('ai') // default preserved
    expect(s.apify_api_token).toBe('tok') // secret from stored
  })
})

describe('getKey', () => {
  it('returns a set value', () => {
    setSettings({ voyage_api_key: 'vk' })
    expect(getKey('voyage_api_key')).toBe('vk')
  })

  it('returns undefined for an unset secret', () => {
    expect(getKey('apify_api_token')).toBeUndefined()
  })

  it('treats an empty (cleared) value as unset', () => {
    setSettings({ voyage_api_key: '' })
    expect(getKey('voyage_api_key')).toBeUndefined()
  })

  it('returns a seeded non-secret default', () => {
    expect(getKey('apify_tweet_actor_id')).toBe('apidojo/tweet-scraper')
  })
})

describe('readiness', () => {
  it('reports which providers have their required key set', () => {
    expect(readiness()).toEqual({ apify: false, voyage: false, anthropic: false })
    setSettings({ apify_api_token: 'a', voyage_api_key: 'v' })
    expect(readiness()).toEqual({ apify: true, voyage: true, anthropic: false })
  })
})
