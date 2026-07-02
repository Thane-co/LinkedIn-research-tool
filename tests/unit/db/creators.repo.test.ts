import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { deleteCreator, listCreators, setCreatorTier, upsertCreator } from '@/lib/db/creators.repo'
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

describe('upsertCreator', () => {
  it('inserts a new creator with a generated id and watch tier by default', () => {
    const row = upsertCreator(jane())
    expect(row.id).toBeTruthy()
    expect(row.tier).toBe('watch')
    expect(row.author_id).toBe('jane')
    expect(row.tags).toBe('[]')
  })

  it('honors an explicit tier on insert', () => {
    expect(upsertCreator(jane({ tier: 'core' })).tier).toBe('core')
  })

  it('serializes tags to a JSON array', () => {
    expect(upsertCreator(jane({ tags: ['ai', 'infra'] })).tags).toBe('["ai","infra"]')
  })

  it('promotes an existing watch creator to core on re-add (no duplicate row)', () => {
    upsertCreator(jane()) // watch
    const promoted = upsertCreator(jane())
    expect(promoted.tier).toBe('core')
    expect(listCreators().creators).toHaveLength(1)
  })

  it('never downgrades a core creator back to watch', () => {
    upsertCreator(jane({ tier: 'core' }))
    const again = upsertCreator(jane({ tier: 'watch' }))
    expect(again.tier).toBe('core')
  })

  it('fills in display_name / avatar on re-add when newly provided', () => {
    upsertCreator(jane({ display_name: null, avatar_url: null }))
    const updated = upsertCreator(jane({ display_name: 'Jane D.', avatar_url: 'https://img/j' }))
    expect(updated.display_name).toBe('Jane D.')
    expect(updated.avatar_url).toBe('https://img/j')
  })
})

describe('setCreatorTier', () => {
  it('explicitly demotes core → watch (and promotes back)', () => {
    const row = upsertCreator(jane({ tier: 'core' }))
    setCreatorTier(row.id, 'watch')
    expect(listCreators({ tier: 'watch' }).creators.map((c) => c.id)).toEqual([row.id])
    setCreatorTier(row.id, 'core')
    expect(listCreators({ tier: 'core' }).creators.map((c) => c.id)).toEqual([row.id])
  })
})

describe('listCreators', () => {
  beforeEach(() => {
    upsertCreator(jane({ profile_url: 'https://li/1', tier: 'core', tags: ['ai'] }))
    upsertCreator(
      jane({ platform: 'twitter', profile_url: 'https://x.com/joe', tags: ['infra', 'ai'] }),
    )
  })

  it('lists all creators and the distinct tag set', () => {
    const { creators, tags } = listCreators()
    expect(creators).toHaveLength(2)
    expect([...tags].sort()).toEqual(['ai', 'infra'])
  })

  it('filters by tier', () => {
    expect(listCreators({ tier: 'core' }).creators).toHaveLength(1)
  })

  it('filters by platform', () => {
    expect(listCreators({ platform: 'twitter' }).creators).toHaveLength(1)
  })

  it('filters by tag', () => {
    expect(listCreators({ tag: 'infra' }).creators).toHaveLength(1)
  })
})

describe('deleteCreator', () => {
  it('removes a creator by id', () => {
    const row = upsertCreator(jane())
    deleteCreator(row.id)
    expect(listCreators().creators).toHaveLength(0)
  })
})
