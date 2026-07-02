import { describe, expect, it } from 'vitest'
import { findContentClusters } from '@/lib/pure/content-clusters'

interface P {
  id: string
  content: string | null
  textEmbedding: number[]
  imageEmbedding: number[] | null
  likes: number
  shares: number
}
const post = (o: Partial<P> & { id: string; textEmbedding: number[] }): P => ({
  content: null,
  imageEmbedding: null,
  likes: 0,
  shares: 0,
  ...o,
})

describe('findContentClusters', () => {
  it('clusters a pair whose combined similarity >= 0.65', () => {
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', textEmbedding: [0.8, 0.6, 0, 0] }), // cosine 0.8
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.postIds.sort()).toEqual(['a', 'b'])
    expect(clusters[0]!.similarity).toBeCloseTo(0.8, 5) // avg pairwise combined similarity
  })

  it('does not cluster a pair below 0.65', () => {
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', textEmbedding: [0.6, 0.8, 0, 0] }), // cosine 0.6
    ])
    expect(clusters).toEqual([])
  })

  it('joins a third post by average-linkage even when its direct pair was below 0.65', () => {
    // a=0deg, b=30deg, c=50deg. (a,c) cosine = 0.643 < 0.65 (not a direct pair),
    // but avg(a,{b,c}) = (0.866+0.643)/2 = 0.754 >= 0.65 and min = 0.643 >= 0.60 -> joins.
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', textEmbedding: [0.866, 0.5, 0, 0] }),
      post({ id: 'c', textEmbedding: [0.643, 0.766, 0, 0] }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.postIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('rejects a candidate when average similarity to the cluster is below 0.65', () => {
    // seed {a,b} (cosine 0.719); c pairs with b (0.695) but avg(c,{a,b}) = 0.347 < 0.65.
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', textEmbedding: [0.719, 0.695, 0, 0] }), // 44deg
      post({ id: 'c', textEmbedding: [0, 1, 0, 0] }), // 90deg: cos(a,c)=0, cos(b,c)=0.695
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.postIds.sort()).toEqual(['a', 'b'])
  })

  it('rejects a candidate that passes the average but violates the 0.60 min-link floor', () => {
    // Gram matrix (m1,m2,d): cos(m1,m2)=0.95, cos(m1,d)=0.74, cos(m2,d)=0.58 (realized via Cholesky).
    // Seed {m1,m2} (0.95 is the top pair). Then (m1,d): avg(d,{m1,m2})=0.66 >= 0.65 (passes)
    // but min = 0.58 < 0.60 -> floor rejects. d is dropped.
    const clusters = findContentClusters([
      post({ id: 'm1', textEmbedding: [1, 0, 0] }),
      post({ id: 'm2', textEmbedding: [0.95, 0.31225, 0] }),
      post({ id: 'd', textEmbedding: [0.74, -0.39391, 0.54519] }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.postIds.sort()).toEqual(['m1', 'm2'])
  })

  it('does not merge two already-assigned clusters (both-assigned pair is skipped)', () => {
    // Three mutually-similar posts: seed {a,b}, join c, then (b,c) both assigned -> skip.
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', textEmbedding: [0.95, 0.312, 0, 0] }),
      post({ id: 'c', textEmbedding: [0.9, 0.436, 0, 0] }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.postIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('labels the cluster from the highest-centrality post (not the highest-engagement one)', () => {
    // b is most central (avg sim ~0.97) though a has the most likes.
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0], likes: 1000, content: 'A is loud but peripheral.' }),
      post({ id: 'b', textEmbedding: [0.95, 0.312, 0, 0], content: 'This is the trend. Extra stuff.' }),
      post({ id: 'c', textEmbedding: [0.9, 0.436, 0, 0], content: 'C is also here.' }),
    ])
    expect(clusters[0]!.label).toBe('This is the trend')
  })

  it('sums engagement and sorts clusters by total (likes+shares) DESC', () => {
    const clusters = findContentClusters([
      // cluster 1 (dims 0-1): engagement 1000
      post({ id: 'a', textEmbedding: [1, 0, 0, 0], likes: 1000 }),
      post({ id: 'b', textEmbedding: [0.9, 0.436, 0, 0] }),
      // cluster 2 (dims 2-3): engagement 30
      post({ id: 'p', textEmbedding: [0, 0, 1, 0], likes: 20, shares: 10 }),
      post({ id: 'q', textEmbedding: [0, 0, 0.9, 0.436] }),
    ])
    expect(clusters.map((c) => c.postIds.sort())).toEqual([
      ['a', 'b'],
      ['p', 'q'],
    ])
    expect(clusters[0]).toMatchObject({ totalLikes: 1000, totalShares: 0 })
    expect(clusters[1]).toMatchObject({ totalLikes: 20, totalShares: 10 })
  })

  it('drops clusters smaller than 2 (an isolated post is not a cluster)', () => {
    const clusters = findContentClusters([
      post({ id: 'a', textEmbedding: [1, 0, 0, 0] }),
      post({ id: 'b', textEmbedding: [0.9, 0.436, 0, 0] }),
      post({ id: 'lonely', textEmbedding: [0, 0, 0, 1] }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.postIds).not.toContain('lonely')
  })
})
