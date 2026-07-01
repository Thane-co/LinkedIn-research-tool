// Layer 0 — x-factor math (PRD §8). Zero I/O. 100% coverage required.
// Invariant (CLAUDE.md): weighted_score = likes*1 + comments*3 + shares*5; baseline = mean
// weighted_score of the same author's posts in the OPEN window (T-30d, T); needs >=3 in-window
// priors or x_factor is null. Both window edges are strict (PRD §8.3, resolved 2026-07-01).

import { BASELINE_WINDOW_DAYS, MIN_SAMPLE_SIZE, WEIGHTS } from '@/lib/config'

const DAY_MS = 24 * 60 * 60 * 1000

export function weightedScore(post: { likes: number; comments: number; shares: number }): number {
  return post.likes * WEIGHTS.likes + post.comments * WEIGHTS.comments + post.shares * WEIGHTS.shares
}

/**
 * priorPosts are the same author's posts. This function defensively re-applies the open window
 * (T-30d, T) so the boundary invariant lives in one place regardless of caller pre-filtering.
 */
export function computeXFactor(
  post: { weighted_score: number; posted_at: string },
  priorPosts: { weighted_score: number; posted_at: string }[],
): { creator_baseline: number | null; x_factor: number | null } {
  const t = Date.parse(post.posted_at)
  const lowerBound = t - BASELINE_WINDOW_DAYS * DAY_MS

  const inWindow = priorPosts.filter((p) => {
    const pt = Date.parse(p.posted_at)
    return pt > lowerBound && pt < t // both edges strict
  })

  if (inWindow.length < MIN_SAMPLE_SIZE) {
    return { creator_baseline: null, x_factor: null }
  }

  const creator_baseline =
    inWindow.reduce((sum, p) => sum + p.weighted_score, 0) / inWindow.length

  if (creator_baseline === 0) {
    return { creator_baseline, x_factor: null }
  }

  return { creator_baseline, x_factor: post.weighted_score / creator_baseline }
}
