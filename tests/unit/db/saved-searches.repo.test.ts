import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { createSavedSearch, deleteSavedSearch, listSavedSearches } from '@/lib/db/saved-searches.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('saved-searches.repo', () => {
  it('creates a saved search with a generated id and round-trips its params', () => {
    const row = createSavedSearch('Viral AI', { platform: 'linkedin', minLikes: 500 })
    expect(row.id).toBeTruthy()
    expect(row.name).toBe('Viral AI')
    expect(JSON.parse(row.params)).toEqual({ platform: 'linkedin', minLikes: 500 })
    expect(listSavedSearches()).toHaveLength(1)
  })

  it('lists newest-first and deletes by id', () => {
    const a = createSavedSearch('A', { sort: 'likes' })
    const b = createSavedSearch('B', { sort: 'recent' })
    expect(listSavedSearches().map((s) => s.id)).toEqual([b.id, a.id]) // newest first
    deleteSavedSearch(a.id)
    expect(listSavedSearches().map((s) => s.id)).toEqual([b.id])
  })
})
