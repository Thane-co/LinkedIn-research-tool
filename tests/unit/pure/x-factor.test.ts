import { describe, expect, it } from 'vitest'
import { computeXFactor, weightedScore } from '@/lib/pure/x-factor'

// Helper: an ISO string N days before a fixed reference instant.
const T = '2026-06-30T00:00:00.000Z'
const daysBefore = (n: number): string =>
  new Date(Date.parse(T) - n * 24 * 60 * 60 * 1000).toISOString()

const prior = (weighted_score: number, daysAgo: number) => ({
  weighted_score,
  posted_at: daysBefore(daysAgo),
})

describe('weightedScore', () => {
  it('applies the 1 / 3 / 5 weighting (likes / comments / shares)', () => {
    expect(weightedScore({ likes: 10, comments: 2, shares: 1 })).toBe(10 * 1 + 2 * 3 + 1 * 5)
  })

  it('is zero for a post with no engagement', () => {
    expect(weightedScore({ likes: 0, comments: 0, shares: 0 })).toBe(0)
  })
})

describe('computeXFactor', () => {
  const post = { weighted_score: 100, posted_at: T }

  it('returns nulls when there are fewer than 3 priors', () => {
    const priors = [prior(10, 1), prior(20, 2)] // only 2
    expect(computeXFactor(post, priors)).toEqual({ creator_baseline: null, x_factor: null })
  })

  it('baseline = mean of prior weighted_scores; x_factor = score / baseline', () => {
    const priors = [prior(10, 1), prior(20, 2), prior(30, 3)] // mean 20
    expect(computeXFactor(post, priors)).toEqual({ creator_baseline: 20, x_factor: 5 })
  })

  it('returns x_factor null when the baseline is 0 (but keeps the baseline)', () => {
    const priors = [prior(0, 1), prior(0, 2), prior(0, 3)]
    expect(computeXFactor(post, priors)).toEqual({ creator_baseline: 0, x_factor: null })
  })

  it('excludes a prior posted exactly 30 days before (strict < window)', () => {
    // Caller pre-filters to [T-30d, T); this asserts the fn itself needs >=3 IN-WINDOW priors.
    // Two in-window + one exactly at the 30d edge -> still only 2 valid -> nulls.
    const priors = [prior(10, 1), prior(20, 2), prior(30, 30)] // 30d-ago excluded
    expect(computeXFactor(post, priors)).toEqual({ creator_baseline: null, x_factor: null })
  })

  it('excludes priors at/after T (strictly before T only)', () => {
    const priors = [prior(10, 1), prior(20, 2), prior(30, 3), { weighted_score: 999, posted_at: T }]
    // the T-dated (and any future) prior is dropped; mean of the 3 valid = 20
    expect(computeXFactor(post, priors)).toEqual({ creator_baseline: 20, x_factor: 5 })
  })

  it('returns nulls when there are no priors at all', () => {
    expect(computeXFactor(post, [])).toEqual({ creator_baseline: null, x_factor: null })
  })
})
