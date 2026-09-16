import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countCommentsByPost, getCommentsForPost, upsertComments } from '@/lib/db/comments.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { makeCommentRow } from '@/tests/fixtures/comments'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('upsertComments', () => {
  it('stores comments and reads a post back oldest first, raw payload included', () => {
    upsertComments([
      makeCommentRow({ id: 'b', commented_at: '2026-09-14T12:00:00.000Z' }),
      makeCommentRow({ id: 'a', commented_at: '2026-09-14T09:00:00.000Z', parent_comment_id: null }),
      makeCommentRow({ id: 'r', commented_at: '2026-09-14T13:00:00.000Z', parent_comment_id: 'a', is_post_author: 1 }),
    ])
    const rows = getCommentsForPost('100')
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'r'])
    expect(rows[2]).toMatchObject({ parent_comment_id: 'a', is_post_author: 1, raw_data: '{}' })
  })

  it('a re-scrape refreshes a comment in place (edited text, new likes), never duplicates it', () => {
    upsertComments([makeCommentRow({ text: 'first', likes: 1 })])
    upsertComments([makeCommentRow({ text: 'edited', likes: 9, edited: 1, scraped_at: '2026-09-16T00:00:00.000Z' })])
    const rows = getCommentsForPost('100')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ text: 'edited', likes: 9, edited: 1, scraped_at: '2026-09-16T00:00:00.000Z' })
  })

  it('reports the number written, and an empty batch is a no-op', () => {
    expect(upsertComments([makeCommentRow({ id: 'x' }), makeCommentRow({ id: 'y' })])).toBe(2)
    expect(upsertComments([])).toBe(0)
  })

  it('keeps each post’s comments separate', () => {
    upsertComments([makeCommentRow({ id: 'x', post_id: '100' }), makeCommentRow({ id: 'y', post_id: '200' })])
    expect(getCommentsForPost('200').map((r) => r.id)).toEqual(['y'])
    expect(getCommentsForPost('nope')).toEqual([])
  })
})

describe('countCommentsByPost', () => {
  it('counts stored comments per post in one query, omitting posts with none', () => {
    upsertComments([
      makeCommentRow({ id: 'x', post_id: '100' }),
      makeCommentRow({ id: 'y', post_id: '100' }),
      makeCommentRow({ id: 'z', post_id: '200' }),
    ])
    const counts = countCommentsByPost(['100', '200', '300'])
    expect(counts.get('100')).toBe(2)
    expect(counts.get('200')).toBe(1)
    expect(counts.has('300')).toBe(false)
  })

  it('handles an empty id list without building a broken query', () => {
    expect(countCommentsByPost([]).size).toBe(0)
  })
})
