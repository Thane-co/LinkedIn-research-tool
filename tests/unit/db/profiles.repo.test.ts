import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { getProfile, getProfileByUrl, listProfiles, upsertProfile } from '@/lib/db/profiles.repo'
import type { ProfileRow } from '@/lib/types'

beforeEach(() => {
  getDb(':memory:')
})
afterEach(() => resetDb())

const row = (over: Partial<ProfileRow> = {}): ProfileRow => ({
  id: 'basiakubicka',
  url: 'https://www.linkedin.com/in/basiakubicka/',
  name: 'Basia Kubicka',
  headline: 'AI PM',
  about: 'I build AI products.',
  followers: 69000,
  connections: 500,
  location: 'Cambridge, Massachusetts',
  avatar_url: 'https://img/basia.png',
  experience: JSON.stringify([{ company: 'Techstars startup' }]),
  education: JSON.stringify([{ school: 'Frankfurt UAS' }]),
  skills: JSON.stringify([{ name: 'Product Management' }]),
  scraped_at: '2026-07-20T10:00:00.000Z',
  raw_data: '{"publicIdentifier":"basiakubicka"}',
  ...over,
})

describe('profiles.repo', () => {
  it('inserts and reads back a profile by id', () => {
    upsertProfile(row())
    const got = getProfile('basiakubicka')
    expect(got).not.toBeNull()
    expect(got!.followers).toBe(69000)
    expect(got!.connections).toBe(500)
    expect(got!.headline).toBe('AI PM')
    expect(JSON.parse(got!.experience!)).toEqual([{ company: 'Techstars startup' }])
  })

  it('returns null for an unknown id / url', () => {
    expect(getProfile('nobody')).toBeNull()
    expect(getProfileByUrl('https://www.linkedin.com/in/nobody/')).toBeNull()
  })

  it('upsert refreshes an existing row (same id) instead of duplicating', () => {
    upsertProfile(row({ followers: 69000, headline: 'AI PM' }))
    upsertProfile(row({ followers: 70500, headline: 'AI Product Manager', scraped_at: '2026-07-21T10:00:00.000Z' }))
    const all = listProfiles()
    expect(all).toHaveLength(1) // one row, refreshed
    expect(all[0]!.followers).toBe(70500)
    expect(all[0]!.headline).toBe('AI Product Manager')
  })

  it('finds a profile by its canonical url', () => {
    upsertProfile(row())
    expect(getProfileByUrl('https://www.linkedin.com/in/basiakubicka/')!.id).toBe('basiakubicka')
  })

  it('lists profiles newest scraped_at first', () => {
    upsertProfile(row({ id: 'older', url: 'https://li/in/older', scraped_at: '2026-07-19T10:00:00.000Z' }))
    upsertProfile(row({ id: 'newer', url: 'https://li/in/newer', scraped_at: '2026-07-20T10:00:00.000Z' }))
    expect(listProfiles().map((p) => p.id)).toEqual(['newer', 'older'])
  })
})
