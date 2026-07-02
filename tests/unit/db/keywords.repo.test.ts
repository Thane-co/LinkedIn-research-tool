import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { addKeyword, deleteKeyword, deleteMarket, listKeywords } from '@/lib/db/keywords.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('keywords.repo', () => {
  it('adds keywords and lists them grouped by market', () => {
    addKeyword('ai', 'llm')
    addKeyword('ai', 'agents')
    addKeyword('linkedin', 'claude code')

    const groups = listKeywords()
    expect(groups.map((g) => g.market).sort()).toEqual(['ai', 'linkedin'])
    const ai = groups.find((g) => g.market === 'ai')!
    expect(ai.terms.map((t) => t.term).sort()).toEqual(['agents', 'llm'])
  })

  it('ignores a duplicate (market, term) via the unique index', () => {
    addKeyword('ai', 'llm')
    addKeyword('ai', 'llm')
    const ai = listKeywords().find((g) => g.market === 'ai')!
    expect(ai.terms).toHaveLength(1)
  })

  it('deletes a single keyword by id', () => {
    const row = addKeyword('ai', 'llm')
    addKeyword('ai', 'agents')
    deleteKeyword(row.id)
    const ai = listKeywords().find((g) => g.market === 'ai')!
    expect(ai.terms.map((t) => t.term)).toEqual(['agents'])
  })

  it('deletes an entire market', () => {
    addKeyword('ai', 'llm')
    addKeyword('linkedin', 'claude code')
    deleteMarket('ai')
    expect(listKeywords().map((g) => g.market)).toEqual(['linkedin'])
  })
})
