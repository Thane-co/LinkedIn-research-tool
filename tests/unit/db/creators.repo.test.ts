import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { deleteCreator, listCreators, upsertCreator } from '@/lib/db/creators.repo'
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
  it('inserts a new creator with a generated id, in the scrape set (tier core) by default', () => {
    const row = upsertCreator(jane())
    expect(row.id).toBeTruthy()
    expect(row.tier).toBe('core')
    expect(row.author_id).toBe('jane')
    expect(row.tags).toBe('[]')
  })

  it('serializes tags to a JSON array', () => {
    expect(upsertCreator(jane({ tags: ['ai', 'infra'] })).tags).toBe('["ai","infra"]')
  })

  it('re-adding an existing creator is idempotent (no duplicate row, stays in the scrape set)', () => {
    upsertCreator(jane())
    const again = upsertCreator(jane())
    expect(again.tier).toBe('core')
    expect(listCreators().creators).toHaveLength(1)
  })

  it('fills in display_name / avatar on re-add when newly provided', () => {
    upsertCreator(jane({ display_name: null, avatar_url: null }))
    const updated = upsertCreator(jane({ display_name: 'Jane D.', avatar_url: 'https://img/j' }))
    expect(updated.display_name).toBe('Jane D.')
    expect(updated.avatar_url).toBe('https://img/j')
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

  it('filters by tier (all creators are core = the scrape set)', () => {
    expect(listCreators({ tier: 'core' }).creators).toHaveLength(2)
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
