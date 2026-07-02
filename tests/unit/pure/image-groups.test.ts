import { describe, expect, it } from 'vitest'
import { findSimilarImageGroups } from '@/lib/pure/image-groups'

interface P {
  id: string
  imageEmbedding: number[]
  image_description: string | null
  content: string | null
  likes: number
  shares: number
}
const post = (o: Partial<P> & { id: string; imageEmbedding: number[] }): P => ({
  image_description: null,
  content: null,
  likes: 0,
  shares: 0,
  ...o,
})

describe('findSimilarImageGroups', () => {
  it('groups two images whose cosine >= 0.80', () => {
    const groups = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', imageEmbedding: [0.98, 0.02, 0, 0] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.postIds.sort()).toEqual(['a', 'b'])
  })

  it('reports the average pairwise image similarity of the group', () => {
    const groups = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', imageEmbedding: [1, 0, 0, 0] }), // identical → cosine 1
    ])
    expect(groups[0]!.similarity).toBeCloseTo(1, 5)
  })

  it('does not group images below the threshold', () => {
    const groups = findSimilarImageGroups([
      post({ id: 'x', imageEmbedding: [1, 0, 0, 0] }),
      post({ id: 'y', imageEmbedding: [0.5, 0.866, 0, 0] }), // cosine 0.5
    ])
    expect(groups).toEqual([])
  })

  it('groups transitively (A~B, B~C, but A not~C) into one component', () => {
    const groups = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', imageEmbedding: [0.866, 0.5, 0, 0] }), // ~a (0.866), ~c (0.866)
      post({ id: 'c', imageEmbedding: [0.5, 0.866, 0, 0] }), // ~a is 0.5 (below)
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.postIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('drops singletons (component size < 2)', () => {
    const groups = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', imageEmbedding: [0.98, 0.02, 0, 0] }),
      post({ id: 'lonely', imageEmbedding: [0, 0, 0, 1] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.postIds).not.toContain('lonely')
  })

  it('sums engagement and sorts groups by total (likes+shares) DESC', () => {
    const groups = findSimilarImageGroups([
      // group 1 (dims 0-1): total engagement 115
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0], likes: 100, image_description: 'A desc' }),
      post({ id: 'b', imageEmbedding: [0.98, 0.02, 0, 0], likes: 15, image_description: 'B desc' }),
      // group 2 (dims 2-3): total engagement 105
      post({ id: 'e', imageEmbedding: [0, 0, 1, 0], likes: 50, shares: 50, content: 'E content' }),
      post({ id: 'f', imageEmbedding: [0, 0, 0.98, 0.02], likes: 5, image_description: 'F desc' }),
    ])
    expect(groups.map((g) => g.postIds.sort())).toEqual([
      ['a', 'b'],
      ['e', 'f'],
    ])
    expect(groups[0]).toMatchObject({ totalLikes: 115, totalShares: 0 })
    expect(groups[1]).toMatchObject({ totalLikes: 55, totalShares: 50 })
  })

  it("sharedDescription = highest-engagement member's description", () => {
    const [group] = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0], likes: 100, image_description: 'winner' }),
      post({ id: 'b', imageEmbedding: [0.98, 0.02, 0, 0], likes: 1, image_description: 'loser' }),
    ])
    expect(group!.sharedDescription).toBe('winner')
  })

  it('falls back to the content snippet when the top member has no description', () => {
    const [group] = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0], likes: 100, content: 'E content' }),
      post({ id: 'b', imageEmbedding: [0.98, 0.02, 0, 0], likes: 1, image_description: 'ignored' }),
    ])
    expect(group!.sharedDescription).toBe('E content')
  })

  it('sharedDescription is null when the top member has neither description nor content', () => {
    const [group] = findSimilarImageGroups([
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0], likes: 100 }),
      post({ id: 'b', imageEmbedding: [0.98, 0.02, 0, 0], likes: 1 }),
    ])
    expect(group!.sharedDescription).toBeNull()
  })

  it('picks the winner even when the higher-engagement member appears second', () => {
    const [group] = findSimilarImageGroups([
      post({ id: 'first', imageEmbedding: [1, 0, 0, 0], likes: 1, image_description: 'loser' }),
      post({ id: 'second', imageEmbedding: [0.98, 0.02, 0, 0], likes: 100, image_description: 'winner' }),
    ])
    expect(group!.sharedDescription).toBe('winner')
  })

  it('respects a custom threshold argument', () => {
    // cosine 0.8: grouped at default 0.80, but NOT at a stricter 0.90
    const posts = [
      post({ id: 'a', imageEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', imageEmbedding: [0.8, 0.6, 0, 0] }),
    ]
    expect(findSimilarImageGroups(posts, 0.9)).toEqual([])
    expect(findSimilarImageGroups(posts, 0.75)).toHaveLength(1)
  })
})
