// Layer 0 — x-factor v2 math (PRD §8). Zero I/O. 100% coverage required.
//
// Invariant (CLAUDE.md / PRD §8): weighted_score = likes*1 + comments*3 + shares*5. `x_score` is a
// robust z: log score, median LEVEL over the last LEVEL_POSTS mature posts within LEVEL_WINDOW_DAYS,
// MAD SPREAD of detrended residuals over SPREAD_WINDOW_DAYS, floored at SPREAD_FLOOR. `x_factor` is
// the ratio to the median level. A post whose LAST measurement was under MATURITY_DAYS after posting
// is excluded from every baseline and flagged provisional; under PROVISIONAL_MIN_DAYS it is not
// scored at all. Every window edge is strict on both sides.

import {
  LEVEL_POSTS,
  LEVEL_WINDOW_DAYS,
  MAD_SCALE,
  MATURITY_DAYS,
  MIN_LEVEL_POSTS,
  MIN_RESIDUALS,
  MIN_SPREAD_POSTS,
  PROVISIONAL_MIN_DAYS,
  SPREAD_FLOOR,
  SPREAD_WINDOW_DAYS,
  WEIGHTS,
} from '@/lib/config'

const DAY_MS = 24 * 60 * 60 * 1000

export function weightedScore(post: { likes: number; comments: number; shares: number }): number {
  return post.likes * WEIGHTS.likes + post.comments * WEIGHTS.comments + post.shares * WEIGHTS.shares
}

/** ln(1 + x): the log transform every score is measured in, so a doubling is one step at any size. */
export function lg(x: number): number {
  return Math.log1p(x)
}

/** Middle value of a numeric list (average of the two middles when even). Callers pass a non-empty list. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Median absolute deviation from the median — the robust spread the z-score is scaled by. */
export function mad(values: number[]): number {
  const m = median(values)
  return median(values.map((v) => Math.abs(v - m)))
}

/** Elapsed days between two ISO instants (may be fractional; negative if measured before posted). */
function ageDays(postedAt: string, measurementInstant: string): number {
  return (Date.parse(measurementInstant) - Date.parse(postedAt)) / DAY_MS
}

/** Maturity from a resolved measurement instant. A missing instant can't be verified → not mature. */
function isMatureAt(postedAt: string, measurementInstant: string | null): boolean {
  if (!measurementInstant) return false
  return ageDays(postedAt, measurementInstant) >= MATURITY_DAYS
}

/**
 * A post is MATURE once its LAST measurement was taken at least MATURITY_DAYS after it was posted.
 * The measurement instant is the latest snapshot's `captured_at` (carried as `measured_at`), falling
 * back to `scraped_at` — the refresh job rewrites counts in place but never touches `scraped_at`, so
 * `scraped_at` alone understates how current a post's numbers are. `nowIso` is reserved: maturity is
 * judged at measurement time, not at the current instant.
 */
export function isMature(
  post: { posted_at: string; measured_at: string | null; scraped_at: string },
  nowIso?: string,
): boolean {
  void nowIso
  return isMatureAt(post.posted_at, post.measured_at ?? post.scraped_at)
}

/** A same-author prior. The function below re-applies every window and maturity rule itself. */
export interface ScoredPrior {
  weighted_score: number
  posted_at: string
  measured_at: string | null
}

export interface XFactorResult {
  creator_level: number | null
  creator_spread: number | null
  x_score: number | null
  x_factor: number | null
  x_provisional: 0 | 1
}

/**
 * The robust, maturity-aware x-factor (PRD §8).
 *
 * `priors` are the SAME author's other posts; this function re-applies maturity and every window edge
 * so the rules live in one place regardless of caller pre-filtering. Both edges of every window are
 * strict.
 */
export function computeXFactor(
  post: { weighted_score: number; posted_at: string; measured_at: string | null; scraped_at: string },
  priors: ScoredPrior[],
): XFactorResult {
  const age = ageDays(post.posted_at, post.measured_at ?? post.scraped_at)
  const provisional: 0 | 1 = age < MATURITY_DAYS ? 1 : 0

  // Under PROVISIONAL_MIN_DAYS of age: the numbers are still a coin flip. No score, flagged provisional
  // so it is rescored after tomorrow's refresh.
  if (age < PROVISIONAL_MIN_DAYS) {
    return { creator_level: null, creator_spread: null, x_score: null, x_factor: null, x_provisional: 1 }
  }

  const noScore: XFactorResult = {
    creator_level: null,
    creator_spread: null,
    x_score: null,
    x_factor: null,
    x_provisional: provisional,
  }

  const t = Date.parse(post.posted_at)

  // Mature priors strictly before T, with a non-null posted_at, ordered by posted_at ascending.
  const maturePriors = priors
    .filter((p) => p.posted_at)
    .filter((p) => Date.parse(p.posted_at) < t) // strictly before T
    .filter((p) => isMatureAt(p.posted_at, p.measured_at))
    .sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at))

  // LEVEL: the last LEVEL_POSTS mature priors within LEVEL_WINDOW_DAYS.
  const levelLower = t - LEVEL_WINDOW_DAYS * DAY_MS
  const levelPool = maturePriors.filter((p) => Date.parse(p.posted_at) > levelLower) // strict
  if (levelPool.length < MIN_LEVEL_POSTS) return noScore
  const levelPosts = levelPool.slice(-LEVEL_POSTS)
  const level = median(levelPosts.map((p) => lg(p.weighted_score)))

  // SPREAD: the detrended MAD over SPREAD_WINDOW_DAYS.
  const spreadLower = t - SPREAD_WINDOW_DAYS * DAY_MS
  const s = maturePriors.filter((p) => Date.parse(p.posted_at) > spreadLower) // strict
  if (s.length < MIN_SPREAD_POSTS) return noScore

  // Detrend the history: each post minus the median of the LEVEL_POSTS immediately before it. A
  // creator whose audience grew is not a permanent outlier against their smaller past self.
  const lgS = s.map((p) => lg(p.weighted_score))
  const residuals: number[] = []
  for (let i = LEVEL_POSTS; i < s.length; i++) {
    residuals.push(lgS[i]! - median(lgS.slice(i - LEVEL_POSTS, i)))
  }
  if (residuals.length < MIN_RESIDUALS) return noScore

  const spread = Math.max(MAD_SCALE * mad(residuals), SPREAD_FLOOR)

  const creator_level = Math.exp(level) - 1
  const x_score = (lg(post.weighted_score) - level) / spread
  const x_factor = creator_level > 0 ? post.weighted_score / creator_level : null

  return { creator_level, creator_spread: spread, x_score, x_factor, x_provisional: provisional }
}
