// Layer 0 — pure. Basia's own performance bucketing for HER LinkedIn posts (spec: content loop).
// Zero I/O. Boundaries are inclusive on the lower bound: a post lands in a bucket when its likes
// count reaches that bucket's floor.

export type PerformanceBucket = 'flop' | 'ok' | 'good' | 'great' | 'viral'

/** Basia's own thresholds on LinkedIn likes count. Boundaries are inclusive on the lower bound. */
export function performanceBucket(likes: number): PerformanceBucket {
  if (likes >= 1000) return 'viral'
  if (likes >= 750) return 'great'
  if (likes >= 500) return 'good'
  if (likes >= 200) return 'ok'
  return 'flop'
}
