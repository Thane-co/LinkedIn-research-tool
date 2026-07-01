// Layer 0 — union-find image grouping (PRD §9.3). Zero I/O. 100% coverage required.

import { IMAGE_SIMILARITY_THRESHOLD, MIN_GROUP_SIZE } from '@/lib/config'
import { cosine } from '@/lib/pure/similarity'
import type { ImageGroup } from '@/lib/types'

interface ImagePost {
  id: string
  imageEmbedding: number[]
  image_description: string | null
  content: string | null
  likes: number
  shares: number
}

const engagement = (p: { likes: number; shares: number }): number => p.likes + p.shares
const snippet = (s: string): string => s.trim().slice(0, 100)

/** Emit connected components (size >= MIN_GROUP_SIZE) of posts whose image cosine >= threshold. */
export function findSimilarImageGroups(
  posts: ImagePost[],
  threshold: number = IMAGE_SIMILARITY_THRESHOLD,
): ImageGroup[] {
  const n = posts.length
  const parent = Array.from({ length: n }, (_, i) => i)

  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    while (parent[i] !== root) {
      const next = parent[i]!
      parent[i] = root
      i = next
    }
    return root
  }
  const union = (i: number, j: number): void => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(posts[i]!.imageEmbedding, posts[j]!.imageEmbedding) >= threshold) {
        union(i, j)
      }
    }
  }

  // Bucket indices by component root.
  const components = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const bucket = components.get(root)
    if (bucket) bucket.push(i)
    else components.set(root, [i])
  }

  const groups: ImageGroup[] = []
  for (const indices of components.values()) {
    if (indices.length < MIN_GROUP_SIZE) continue
    const members = indices.map((i) => posts[i]!)
    const top = members.reduce((best, p) => (engagement(p) > engagement(best) ? p : best))
    const sharedDescription =
      top.image_description ?? (top.content ? snippet(top.content) : null)
    groups.push({
      postIds: members.map((p) => p.id),
      sharedDescription,
      totalLikes: members.reduce((s, p) => s + p.likes, 0),
      totalShares: members.reduce((s, p) => s + p.shares, 0),
    })
  }

  groups.sort((a, b) => b.totalLikes + b.totalShares - (a.totalLikes + a.totalShares))
  return groups
}
