// Layer 0 — greedy average-linkage content clustering (PRD §9.4). Zero I/O. 100% coverage.

import { CONTENT_FLOOR, CONTENT_SIMILARITY_THRESHOLD, MIN_GROUP_SIZE } from '@/lib/config'
import { combined } from '@/lib/pure/similarity'
import type { ContentCluster } from '@/lib/types'

interface ClusterPost {
  id: string
  content: string | null
  textEmbedding: number[]
  imageEmbedding: number[] | null
  likes: number
  shares: number
}

/** First sentence of the content, capped at 100 chars; null when there is no content. */
function firstSentence(content: string | null): string | null {
  if (!content) return null
  const sentence = content.split(/[.!?]/, 1)[0]!.trim()
  return sentence.slice(0, 100)
}

export function findContentClusters(
  posts: ClusterPost[],
  threshold: number = CONTENT_SIMILARITY_THRESHOLD,
): ContentCluster[] {
  const n = posts.length

  // Precompute pairwise combined similarities (O(n^2), n <= 400).
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const pairs: { i: number; j: number; s: number }[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = combined(posts[i]!, posts[j]!)
      sim[i]![j] = s
      sim[j]![i] = s
      if (s >= threshold) pairs.push({ i, j, s })
    }
  }
  pairs.sort((a, b) => b.s - a.s)

  const clusterOf = new Array<number>(n).fill(-1) // cluster index per post, -1 = unassigned
  const clusters: number[][] = []

  const avgSim = (idx: number, members: number[]): number =>
    members.reduce((sum, m) => sum + sim[idx]![m]!, 0) / members.length
  const minSim = (idx: number, members: number[]): number =>
    members.reduce((lo, m) => Math.min(lo, sim[idx]![m]!), Infinity)

  const tryAdd = (idx: number, cid: number): void => {
    const members = clusters[cid]!
    if (avgSim(idx, members) >= threshold && minSim(idx, members) >= CONTENT_FLOOR) {
      members.push(idx)
      clusterOf[idx] = cid
    }
  }

  for (const { i, j } of pairs) {
    const ci = clusterOf[i]!
    const cj = clusterOf[j]!
    if (ci === -1 && cj === -1) {
      clusters.push([i, j])
      clusterOf[i] = clusters.length - 1
      clusterOf[j] = clusters.length - 1
    } else if (ci !== -1 && cj === -1) {
      tryAdd(j, ci)
    } else if (ci === -1 && cj !== -1) {
      tryAdd(i, cj)
    }
    // both assigned -> skip (no cluster merging)
  }

  const result: ContentCluster[] = []
  for (const members of clusters) {
    // Clusters are seeded as pairs and only grow, so this never fires while MIN_GROUP_SIZE === 2;
    // it's kept to enforce the spec's min-size rule should MIN_GROUP_SIZE ever be raised above 2.
    /* v8 ignore next */
    if (members.length < MIN_GROUP_SIZE) continue

    // Centrality = avg similarity to the other members; label = first sentence of the winner.
    let best = members[0]!
    let bestCentrality = -Infinity
    for (const m of members) {
      const others = members.filter((o) => o !== m)
      const centrality = others.reduce((sum, o) => sum + sim[m]![o]!, 0) / others.length
      if (centrality > bestCentrality) {
        bestCentrality = centrality
        best = m
      }
    }

    // Cohesion = average pairwise combined similarity among the members (>=1 pair; size >= 2).
    let simSum = 0
    let simCount = 0
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        simSum += sim[members[a]!]![members[b]!]!
        simCount++
      }
    }

    result.push({
      postIds: members.map((m) => posts[m]!.id),
      label: firstSentence(posts[best]!.content),
      similarity: simSum / simCount,
      totalLikes: members.reduce((s, m) => s + posts[m]!.likes, 0),
      totalShares: members.reduce((s, m) => s + posts[m]!.shares, 0),
    })
  }

  result.sort((a, b) => b.totalLikes + b.totalShares - (a.totalLikes + a.totalShares))
  return result
}
