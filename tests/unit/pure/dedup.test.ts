import { describe, expect, it } from 'vitest'
import { deduplicatePosts, mergeAndDeduplicate } from '@/lib/pure/dedup'
import { makePostRow } from '@/tests/fixtures/posts'

describe('mergeAndDeduplicate', () => {
  it('unions the two sources keyed by id', () => {
    const res = mergeAndDeduplicate(
      [makePostRow({ id: 'a' }), makePostRow({ id: 'b' })],
      [makePostRow({ id: 'b' }), makePostRow({ id: 'c' })],
    )
    expect(res.posts.map((p) => p.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it("tags a post seen in both sources as scrape_source 'both' and counts foundInBoth", () => {
    const res = mergeAndDeduplicate([makePostRow({ id: 'b' })], [makePostRow({ id: 'b' })])
    expect(res.foundInBoth).toBe(1)
    expect(res.posts[0]!.scrape_source).toBe('both')
  })

  it('preserves the single-source label for non-overlapping posts', () => {
    const res = mergeAndDeduplicate([makePostRow({ id: 'a' })], [makePostRow({ id: 'c' })])
    const byId = Object.fromEntries(res.posts.map((p) => [p.id, p.scrape_source]))
    expect(byId).toEqual({ a: 'keyword', c: 'creator' })
  })

  it('is first-wins on row data (keyword copy kept when id overlaps)', () => {
    const res = mergeAndDeduplicate(
      [makePostRow({ id: 'b', content: 'from keyword' })],
      [makePostRow({ id: 'b', content: 'from creator' })],
    )
    expect(res.posts[0]!.content).toBe('from keyword')
  })

  it('counts duplicates as collapsed rows (including within a single source)', () => {
    const res = mergeAndDeduplicate(
      [makePostRow({ id: 'a' }), makePostRow({ id: 'a' })], // within-source dup
      [makePostRow({ id: 'a' })], // cross-source dup
    )
    expect(res.posts).toHaveLength(1)
    expect(res.duplicates).toBe(2) // 3 valid inputs -> 1 unique
    expect(res.foundInBoth).toBe(1)
  })

  it('skips rows with a null or empty id (not counted as duplicates)', () => {
    const res = mergeAndDeduplicate(
      [makePostRow({ id: '' }), makePostRow({ id: 'a' })],
      [makePostRow({ id: null as unknown as string })],
    )
    expect(res.posts.map((p) => p.id)).toEqual(['a'])
    expect(res.duplicates).toBe(0)
  })

  it('handles two empty arrays', () => {
    expect(mergeAndDeduplicate([], [])).toEqual({ posts: [], duplicates: 0, foundInBoth: 0 })
  })

  it('does not mutate the input rows', () => {
    const input = makePostRow({ id: 'b', scrape_source: null })
    mergeAndDeduplicate([input], [makePostRow({ id: 'b' })])
    expect(input.scrape_source).toBeNull()
  })
})

describe('deduplicatePosts (fingerprint)', () => {
  it('collapses reposts with different ids but same author + content fingerprint', () => {
    const out = deduplicatePosts([
      makePostRow({ id: 'x1', author_id: 'jane', author_name: 'Jane', content: 'same body' }),
      makePostRow({ id: 'x2', author_id: 'jane', author_name: 'Jane', content: 'same body' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('x1') // first-wins
  })

  it('keeps posts that differ within the first 200 content chars', () => {
    const out = deduplicatePosts([
      makePostRow({ id: 'x1', author_id: 'jane', content: 'alpha' }),
      makePostRow({ id: 'x2', author_id: 'jane', content: 'beta' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('keeps posts from different authors with identical content', () => {
    const out = deduplicatePosts([
      makePostRow({ id: 'x1', author_id: 'jane', content: 'same' }),
      makePostRow({ id: 'x2', author_id: 'joe', content: 'same' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('collapses two rows that are both fully null on the fingerprint fields', () => {
    const nulls = { author_id: null, author_name: null, content: null }
    const out = deduplicatePosts([
      makePostRow({ id: 'x1', ...nulls }),
      makePostRow({ id: 'x2', ...nulls }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('x1')
  })
})
