import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import {
  countSnapshots,
  getSnapshots,
  latestSnapshotDay,
  recordSnapshot,
  recordSnapshots,
  seedSnapshotsFromProfiles,
  type NewSnapshot,
} from '@/lib/db/followers.repo'
import { upsertProfile } from '@/lib/db/profiles.repo'
import type { ProfileRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const snap = (over: Partial<NewSnapshot> = {}): NewSnapshot => ({
  author_id: 'jane',
  platform: 'linkedin',
  captured_on: '2026-09-09',
  captured_at: '2026-09-09T06:00:00.000Z',
  followers: 1000,
  connections: 500,
  source: 'profile-actor',
  ...over,
})

describe('recordSnapshot', () => {
  it('stores one row and reads it back', () => {
    recordSnapshot(snap())
    expect(getSnapshots('jane', 'linkedin')).toEqual([
      {
        captured_on: '2026-09-09',
        captured_at: '2026-09-09T06:00:00.000Z',
        followers: 1000,
      },
    ])
  })

  it('is idempotent per day — a second capture on the same day overwrites, never duplicates', () => {
    recordSnapshot(snap({ followers: 1000, captured_at: '2026-09-09T06:00:00.000Z' }))
    recordSnapshot(snap({ followers: 1010, captured_at: '2026-09-09T20:00:00.000Z' }))
    const rows = getSnapshots('jane', 'linkedin')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ followers: 1010, captured_at: '2026-09-09T20:00:00.000Z' })
  })

  it('keeps the same handle on two platforms apart', () => {
    recordSnapshot(snap({ platform: 'linkedin', followers: 1000 }))
    recordSnapshot(snap({ platform: 'twitter', followers: 77 }))
    expect(getSnapshots('jane', 'linkedin')[0]?.followers).toBe(1000)
    expect(getSnapshots('jane', 'twitter')[0]?.followers).toBe(77)
  })

  it('returns the series oldest first, whatever order it went in', () => {
    recordSnapshot(snap({ captured_on: '2026-09-09', captured_at: '2026-09-09T06:00:00.000Z' }))
    recordSnapshot(snap({ captured_on: '2026-09-07', captured_at: '2026-09-07T06:00:00.000Z' }))
    recordSnapshot(snap({ captured_on: '2026-09-08', captured_at: '2026-09-08T06:00:00.000Z' }))
    expect(getSnapshots('jane', 'linkedin').map((s) => s.captured_on)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
    ])
  })

  it('returns an empty series for a creator never captured', () => {
    expect(getSnapshots('nobody', 'linkedin')).toEqual([])
  })
})

describe('recordSnapshots (batch)', () => {
  it('writes every row in one transaction and reports the count', () => {
    const n = recordSnapshots([snap({ author_id: 'a' }), snap({ author_id: 'b' }), snap({ author_id: 'c' })])
    expect(n).toBe(3)
    expect(countSnapshots()).toBe(3)
  })

  it('an empty batch is a no-op, not an error', () => {
    expect(recordSnapshots([])).toBe(0)
  })
})

describe('latestSnapshotDay', () => {
  it('returns null before anything is captured', () => {
    expect(latestSnapshotDay('linkedin')).toBeNull()
  })

  it('returns the newest day key captured for the platform', () => {
    recordSnapshot(snap({ captured_on: '2026-09-07', captured_at: '2026-09-07T06:00:00.000Z' }))
    recordSnapshot(snap({ captured_on: '2026-09-09', captured_at: '2026-09-09T06:00:00.000Z' }))
    recordSnapshot(snap({ platform: 'twitter', captured_on: '2026-09-30', captured_at: '2026-09-30T06:00:00.000Z' }))
    expect(latestSnapshotDay('linkedin')).toBe('2026-09-09')
  })
})

describe('seedSnapshotsFromProfiles', () => {
  const profile = (id: string, followers: number, scraped_at: string): ProfileRow => ({
    id,
    url: `https://www.linkedin.com/in/${id}`,
    name: id,
    headline: null,
    about: null,
    followers,
    connections: 0,
    location: null,
    avatar_url: null,
    experience: null,
    education: null,
    skills: null,
    scraped_at,
    raw_data: null,
  })

  it('turns each already-scraped profile into its first data point, day-keyed off scraped_at', () => {
    upsertProfile(profile('jane', 12_000, '2026-08-01T09:30:00.000Z'))
    upsertProfile(profile('bob', 3_000, '2026-08-02T09:30:00.000Z'))
    expect(seedSnapshotsFromProfiles()).toBe(2)
    expect(getSnapshots('jane', 'linkedin')).toEqual([
      { captured_on: '2026-08-01', captured_at: '2026-08-01T09:30:00.000Z', followers: 12_000 },
    ])
  })

  it('never overwrites a real capture with a stale seed', () => {
    recordSnapshot(snap({ author_id: 'jane', captured_on: '2026-08-01', followers: 999 }))
    upsertProfile(profile('jane', 12_000, '2026-08-01T09:30:00.000Z'))
    seedSnapshotsFromProfiles()
    expect(getSnapshots('jane', 'linkedin')[0]?.followers).toBe(999)
  })

  it('skips profiles with no follower count — a 0 is missing data, not a measurement', () => {
    upsertProfile(profile('ghost', 0, '2026-08-01T09:30:00.000Z'))
    expect(seedSnapshotsFromProfiles()).toBe(0)
    expect(countSnapshots()).toBe(0)
  })

  it('is safe to re-run', () => {
    upsertProfile(profile('jane', 12_000, '2026-08-01T09:30:00.000Z'))
    seedSnapshotsFromProfiles()
    seedSnapshotsFromProfiles()
    expect(countSnapshots()).toBe(1)
  })
})
