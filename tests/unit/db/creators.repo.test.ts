import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { deleteCreator, listCreators, setCreatorTracking, upsertCreator } from '@/lib/db/creators.repo'
import type { NewCreator } from '@/lib/db/creators.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const jane = (over: Partial<NewCreator> = {}): NewCreator => ({
  platform: 'linkedin',
  profile_url: 'https://www.linkedin.com/in/jane',
  author_id: 'jane',
  display_name: 'Jane Doe',
  ...over,
})

describe('track_followers (§21.8)', () => {
  it('defaults to OFF — follower tracking is opt-in, so adding a creator never adds a daily cost', () => {
    expect(upsertCreator(jane()).track_followers).toBe(0)
  })

  it('setCreatorTracking flips the flag and returns the updated row', () => {
    const row = upsertCreator(jane())
    expect(setCreatorTracking(row.id, true)?.track_followers).toBe(1)
    expect(setCreatorTracking(row.id, false)?.track_followers).toBe(0)
  })

  it('returns null for an unknown creator rather than pretending it worked', () => {
    expect(setCreatorTracking('nope', true)).toBeNull()
  })

  it('re-adding a creator never resets tracking they already turned on', () => {
    const row = upsertCreator(jane())
    setCreatorTracking(row.id, true)
    expect(upsertCreator(jane({ display_name: 'Jane Renamed' })).track_followers).toBe(1)
  })

  it('listCreators can filter down to the tracked subset', () => {
    const a = upsertCreator(jane())
    upsertCreator(jane({ profile_url: 'https://www.linkedin.com/in/bob', author_id: 'bob' }))
    setCreatorTracking(a.id, true)

    const tracked = listCreators({ platform: 'linkedin', tracked: true }).creators
    expect(tracked.map((c) => c.author_id)).toEqual(['jane'])
    // The scrape roster is untouched by the tracking flag — two lists, one roster.
    expect(listCreators({ platform: 'linkedin' }).creators).toHaveLength(2)
  })
})

describe('upsertCreator', () => {
  it('inserts a new creator with a generated id, in the scrape set by default', () => {
    const row = upsertCreator(jane())
    expect(row.id).toBeTruthy()
    expect(row.author_id).toBe('jane')
    expect(row.tags).toBe('[]')
  })

  it('serializes tags to a JSON array', () => {
    expect(upsertCreator(jane({ tags: ['ai', 'infra'] })).tags).toBe('["ai","infra"]')
  })

  it('re-adding an existing creator is idempotent (no duplicate row, stays in the scrape set)', () => {
    upsertCreator(jane())
    const again = upsertCreator(jane())
    expect(listCreators().creators).toHaveLength(1)
  })

  it('fills in display_name / avatar on re-add when newly provided', () => {
    upsertCreator(jane({ display_name: null, avatar_url: null }))
    const updated = upsertCreator(jane({ display_name: 'Jane D.', avatar_url: 'https://img/j' }))
    expect(updated.display_name).toBe('Jane D.')
    expect(updated.avatar_url).toBe('https://img/j')
  })

  it('stores the persona label (§17.2) and defaults it to null', () => {
    expect(upsertCreator(jane()).persona).toBeNull()
    expect(upsertCreator(jane({ profile_url: 'https://li/p', persona: 'lara acosta' })).persona).toBe('lara acosta')
  })

  it('COALESCEs persona on re-add: a new value overrides, an omitted one is preserved', () => {
    upsertCreator(jane({ persona: 'lara acosta' }))
    expect(upsertCreator(jane({ persona: null })).persona).toBe('lara acosta') // omitted → kept
    expect(upsertCreator(jane({ persona: 'l acosta' })).persona).toBe('l acosta') // provided → wins
  })
})


describe('listCreators', () => {
  beforeEach(() => {
    upsertCreator(jane({ profile_url: 'https://li/1', tags: ['ai'] }))
    upsertCreator(
      jane({ platform: 'twitter', profile_url: 'https://x.com/joe', tags: ['infra', 'ai'] }),
    )
  })

  it('lists all creators and the distinct tag set', () => {
    const { creators, tags } = listCreators()
    expect(creators).toHaveLength(2)
    expect([...tags].sort()).toEqual(['ai', 'infra'])
  })

  it('filters by platform', () => {
    expect(listCreators({ platform: 'twitter' }).creators).toHaveLength(1)
  })

  it('filters by tag', () => {
    expect(listCreators({ tag: 'infra' }).creators).toHaveLength(1)
  })

  it('does not crash on a corrupt tags value — skips it and still lists every creator', () => {
    // Force one row's tags column to invalid JSON, then confirm the whole list survives.
    getDb().prepare("UPDATE creators SET tags = 'not json' WHERE profile_url = 'https://x.com/joe'").run()
    const { creators, tags } = listCreators()
    expect(creators).toHaveLength(2) // the corrupt row is still listed
    expect([...tags].sort()).toEqual(['ai']) // its tags are skipped; good rows' tags remain
  })
})

describe('deleteCreator', () => {
  it('removes a creator by id', () => {
    const row = upsertCreator(jane())
    deleteCreator(row.id)
    expect(listCreators().creators).toHaveLength(0)
  })
})
