// Layer 0 — creator pivot: one row per PERSON, one column per platform (PRD §11.8). Zero I/O.
import { describe, expect, it } from 'vitest'
import { countByPlatform, groupCreatorsByPerson, shortAccountLabel } from '@/lib/pure/creator-table'
import type { CreatorRow, Platform } from '@/lib/types'

let n = 0
const creator = (over: Partial<CreatorRow>): CreatorRow => ({
  id: `c${++n}`,
  platform: 'linkedin',
  profile_url: `https://example.com/${n}`,
  author_id: null,
  display_name: null,
  avatar_url: null,
  persona: null,
  track_followers: 0,
  tags: '[]',
  market: 'ai',
  notes: null,
  added_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('countByPlatform', () => {
  it('counts every platform, including the ones with none', () => {
    const counts = countByPlatform([creator({ platform: 'linkedin' }), creator({ platform: 'linkedin' }), creator({ platform: 'substack' })])
    expect(counts).toEqual({ linkedin: 2, twitter: 0, substack: 1, instagram: 0 })
  })
})

describe('groupCreatorsByPerson', () => {
  it('puts one person on one row with a cell per platform', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'linkedin', persona: 'luna chen', display_name: 'Luna Chen' }),
      creator({ platform: 'twitter', persona: 'luna chen', display_name: 'Luna Chen', author_id: 'lunachen' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('Luna Chen')
    expect(rows[0]!.accounts.linkedin).toHaveLength(1)
    expect(rows[0]!.accounts.twitter).toHaveLength(1)
    expect(rows[0]!.accounts.substack).toEqual([])
    expect(rows[0]!.platformCount).toBe(2)
  })

  it('falls back to the derived name key when persona is unset', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'linkedin', display_name: 'Addy Osmani' }),
      creator({ platform: 'twitter', display_name: 'addy osmani' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.platformCount).toBe(2)
  })

  it('prefers an explicit persona over the derived name', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'linkedin', display_name: 'Basia Kubicka', persona: 'basia' }),
      creator({ platform: 'twitter', display_name: 'Totally Different', persona: 'basia' }),
    ])
    expect(rows).toHaveLength(1)
  })

  it('keeps unlinkable accounts (no persona, no name) on their own rows', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'linkedin', profile_url: 'https://x.test/a' }),
      creator({ platform: 'twitter', profile_url: 'https://x.test/b' }),
    ])
    expect(rows).toHaveLength(2)
  })

  it('never drops a second account on the same platform', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'substack', persona: 'jane roe', display_name: 'Jane Roe', profile_url: 'https://a.test' }),
      creator({ platform: 'substack', persona: 'jane roe', display_name: 'Jane Roe', profile_url: 'https://b.test' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.accounts.substack).toHaveLength(2)
    expect(rows[0]!.platformCount).toBe(1)
  })

  it('labels from author_id, then profile_url, when there is no display name', () => {
    const [byHandle] = groupCreatorsByPerson([creator({ platform: 'twitter', author_id: 'someone', persona: 'p1' })])
    expect(byHandle!.label).toBe('someone')
    const [byUrl] = groupCreatorsByPerson([creator({ platform: 'twitter', profile_url: 'https://x.com/nobody', persona: 'p2' })])
    expect(byUrl!.label).toBe('https://x.com/nobody')
  })

  it('keeps the url label when a later account for the same person also has no name', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'linkedin', persona: 'p', profile_url: 'https://first.test' }),
      creator({ platform: 'twitter', persona: 'p', profile_url: 'https://second.test' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('https://first.test')
  })

  it('upgrades a handle label to a real display name from a later account', () => {
    const rows = groupCreatorsByPerson([
      creator({ platform: 'twitter', persona: 'p', author_id: 'janedev' }),
      creator({ platform: 'linkedin', persona: 'p', display_name: 'Jane Doe' }),
    ])
    expect(rows[0]!.label).toBe('Jane Doe')
  })

  it('sorts rows by label, case-insensitively', () => {
    const rows = groupCreatorsByPerson([
      creator({ display_name: 'zoe', persona: 'z' }),
      creator({ display_name: 'Adam', persona: 'a' }),
      creator({ display_name: 'brian', persona: 'b' }),
    ])
    expect(rows.map((r) => r.label)).toEqual(['Adam', 'brian', 'zoe'])
  })

  it('returns no rows for no creators', () => {
    expect(groupCreatorsByPerson([])).toEqual([])
  })

  it('reports which platforms a person is missing, for the add-account cells', () => {
    const [row] = groupCreatorsByPerson([creator({ platform: 'linkedin', persona: 'solo', display_name: 'Solo' })])
    expect(row!.missing.sort()).toEqual(['instagram', 'substack', 'twitter'] as Platform[])
  })
})

describe('shortAccountLabel', () => {
  it('prefers the handle', () => {
    expect(shortAccountLabel(creator({ author_id: 'janedev', profile_url: 'https://x.com/janedev' }))).toBe('janedev')
  })

  it('falls back to the last path segment of the url, not the whole url', () => {
    expect(shortAccountLabel(creator({ author_id: null, profile_url: 'https://www.linkedin.com/in/aagupta/' }))).toBe(
      'aagupta',
    )
    expect(shortAccountLabel(creator({ author_id: null, profile_url: 'https://ada.substack.com' }))).toBe(
      'ada.substack.com',
    )
  })

  it('decodes a percent-encoded segment so it is readable', () => {
    expect(
      shortAccountLabel(creator({ author_id: null, profile_url: 'https://www.linkedin.com/in/%F0%9F%90%9D-luna-chen-373317160/' })),
    ).toBe('🐝-luna-chen-373317160')
  })

  it('falls back to the raw url when there is nothing else', () => {
    expect(shortAccountLabel(creator({ author_id: null, profile_url: 'not a url' }))).toBe('not a url')
  })
})
