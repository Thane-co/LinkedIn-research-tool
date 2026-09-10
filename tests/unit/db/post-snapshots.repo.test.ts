import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import {
  countPostSnapshots,
  getPostSnapshots,
  getPostSnapshotsFor,
  recordPostSnapshots,
  type NewPostSnapshot,
} from '@/lib/db/post-snapshots.repo'
import { insertPosts } from '@/lib/db/posts.repo'
import type { PostRow } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const snap = (over: Partial<NewPostSnapshot> = {}): NewPostSnapshot => ({
  post_id: 'p1',
  captured_on: '2026-09-10',
  captured_at: '2026-09-10T06:00:00.000Z',
  likes: 100,
  comments: 10,
  shares: 2,
  ...over,
})

const post = (id: string, author_id: string, posted_at: string): PostRow =>
  ({
    id, platform: 'linkedin', url: `https://li/${id}`, content: id,
    author_name: author_id, author_url: null, author_id, author_type: 'profile',
    likes: 0, shares: 0, comments: 0, posted_at, scraped_at: '2026-09-10T00:00:00.000Z',
    is_repost: 0, scrape_source: 'creator', market: 'ai', media: null, transcript: null,
    embedding: null, image_url: null, image_description: null, image_embedding: null,
    embedded_at: null, weighted_score: 0, creator_baseline: null, x_factor: null, raw_data: null,
  }) as unknown as PostRow

describe('recordPostSnapshots', () => {
  it('stores a snapshot and reads it back', () => {
    recordPostSnapshots([snap()])
    expect(getPostSnapshots('p1')).toEqual([
      { captured_on: '2026-09-10', captured_at: '2026-09-10T06:00:00.000Z', likes: 100, comments: 10, shares: 2 },
    ])
  })

  it('is idempotent per day — a second capture refreshes, never duplicates', () => {
    recordPostSnapshots([snap({ likes: 100 })])
    recordPostSnapshots([snap({ likes: 140, captured_at: '2026-09-10T20:00:00.000Z' })])
    const rows = getPostSnapshots('p1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ likes: 140, captured_at: '2026-09-10T20:00:00.000Z' })
  })

  it('writes a batch in one transaction and reports the count', () => {
    expect(recordPostSnapshots([snap({ post_id: 'a' }), snap({ post_id: 'b' })])).toBe(2)
    expect(countPostSnapshots()).toBe(2)
  })

  it('an empty batch is a no-op', () => {
    expect(recordPostSnapshots([])).toBe(0)
  })

  it('returns the series oldest first regardless of insert order', () => {
    recordPostSnapshots([
      snap({ captured_on: '2026-09-11', captured_at: '2026-09-11T06:00:00.000Z' }),
      snap({ captured_on: '2026-09-09', captured_at: '2026-09-09T06:00:00.000Z' }),
      snap({ captured_on: '2026-09-10', captured_at: '2026-09-10T06:00:00.000Z' }),
    ])
    expect(getPostSnapshots('p1').map((s) => s.captured_on)).toEqual([
      '2026-09-09', '2026-09-10', '2026-09-11',
    ])
  })

  it('is empty for a post never captured', () => {
    expect(getPostSnapshots('nope')).toEqual([])
  })
})

describe('getPostSnapshotsFor', () => {
  it('loads many posts series in one query, keyed by post id', () => {
    insertPosts([post('a', 'jane', '2026-09-08T09:00:00.000Z'), post('b', 'jane', '2026-09-09T09:00:00.000Z')])
    recordPostSnapshots([
      snap({ post_id: 'a', captured_on: '2026-09-09', captured_at: '2026-09-09T06:00:00.000Z', likes: 10 }),
      snap({ post_id: 'a', captured_on: '2026-09-10', captured_at: '2026-09-10T06:00:00.000Z', likes: 30 }),
      snap({ post_id: 'b', captured_on: '2026-09-10', captured_at: '2026-09-10T06:00:00.000Z', likes: 5 }),
    ])

    const map = getPostSnapshotsFor(['a', 'b'])
    expect(map.get('a')?.map((s) => s.likes)).toEqual([10, 30])
    expect(map.get('b')).toHaveLength(1)
  })

  it('omits posts with no snapshots rather than returning empty arrays', () => {
    expect(getPostSnapshotsFor(['ghost']).has('ghost')).toBe(false)
  })

  it('handles an empty id list without building a broken query', () => {
    expect(getPostSnapshotsFor([]).size).toBe(0)
  })
})
