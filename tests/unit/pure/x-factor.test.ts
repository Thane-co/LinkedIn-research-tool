import { describe, expect, it } from 'vitest'
import { computeXFactor, isMature, lg, mad, median, weightedScore } from '@/lib/pure/x-factor'
import { LEVEL_POSTS, SPREAD_FLOOR } from '@/lib/config'

// A fixed reference instant. Priors are dated N days before it; the scored post sits at T.
const T = '2026-06-30T00:00:00.000Z'
const Tms = Date.parse(T)
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()
const daysBefore = (n: number): string => iso(Tms - n * DAY)

/**
 * A same-author prior posted `daysAgo` before T, whose last measurement was taken `matureAfter` days
 * after it was posted (default 3 = exactly mature). matureAfter < 3 makes it immature.
 */
const prior = (weighted_score: number, daysAgo: number, matureAfter = 3) => ({
  weighted_score,
  posted_at: daysBefore(daysAgo),
  measured_at: daysBefore(daysAgo - matureAfter),
})

/** The post being scored: posted at T, its numbers measured `ageAtMeasurement` days later. */
const scored = (weighted_score: number, ageAtMeasurement: number) => ({
  weighted_score,
  posted_at: T,
  measured_at: iso(Tms + ageAtMeasurement * DAY),
  scraped_at: iso(Tms + ageAtMeasurement * DAY),
})

/** N mature priors, most-recent last, each `gapDays` apart starting `firstDaysAgo` before T. */
const history = (scores: number[], firstDaysAgo = 40): ReturnType<typeof prior>[] =>
  scores.map((s, i) => prior(s, firstDaysAgo - i))

describe('weightedScore', () => {
  it('applies the 1 / 3 / 5 weighting (likes / comments / shares)', () => {
    expect(weightedScore({ likes: 10, comments: 2, shares: 1 })).toBe(10 * 1 + 2 * 3 + 1 * 5)
  })

  it('is zero for a post with no engagement', () => {
    expect(weightedScore({ likes: 0, comments: 0, shares: 0 })).toBe(0)
  })
})

describe('median / mad / lg helpers', () => {
  it('median of an odd-length list is the middle value', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('median of an even-length list averages the two middles', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('mad returns the median absolute deviation from the median', () => {
    // median = 3; abs deviations [2,1,0,1,2]; median of those = 1
    expect(mad([1, 2, 3, 4, 5])).toBe(1)
    // all identical -> zero spread
    expect(mad([7, 7, 7])).toBe(0)
  })

  it('lg(0) = 0 and lg is ln(1 + x)', () => {
    expect(lg(0)).toBe(0)
    expect(lg(Math.E - 1)).toBeCloseTo(1, 12)
  })
})

describe('isMature', () => {
  it('is mature at exactly 3.0 days, not at 2.99', () => {
    const at3 = { posted_at: T, measured_at: iso(Tms + 3 * DAY), scraped_at: T }
    const at299 = { posted_at: T, measured_at: iso(Tms + 2.99 * DAY), scraped_at: T }
    expect(isMature(at3)).toBe(true)
    expect(isMature(at299)).toBe(false)
  })

  it('uses measured_at when present, else falls back to scraped_at', () => {
    // measured_at says mature (5d) even though scraped_at is only 1d after posting
    const viaMeasured = { posted_at: T, measured_at: iso(Tms + 5 * DAY), scraped_at: iso(Tms + 1 * DAY) }
    expect(isMature(viaMeasured)).toBe(true)
    // no measured_at -> scraped_at (1d) governs -> not mature
    const viaScraped = { posted_at: T, measured_at: null, scraped_at: iso(Tms + 1 * DAY) }
    expect(isMature(viaScraped)).toBe(false)
    // no measured_at but scraped_at is old enough -> mature
    const viaScrapedOld = { posted_at: T, measured_at: null, scraped_at: iso(Tms + 4 * DAY) }
    expect(isMature(viaScrapedOld)).toBe(true)
  })
})

// A valid, scoring history: 18 mature priors, 8 at 100 then 10 at 1000, all inside both windows.
// level = median of the last 10 lg-scores = lg(1000); creator_level = 1000.
const CLEAN_HISTORY = [...history([100, 100, 100, 100, 100, 100, 100, 100], 40), ...history([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], 32)]

// A boundary-probe history: 8 mature priors INSIDE the 60d level window (days 5..54) plus 12 older
// mature priors between 60d and 180d (days 61..138). Total 20 within the spread window, so it scores;
// the level median is over the 8 recent ones (fewer than LEVEL_POSTS, so all of them count). This lets
// a prior added at EXACTLY 60d change the level iff the boundary is inclusive — it must not.
const RECENT_DAYS = [5, 12, 19, 26, 33, 40, 47, 54]
const RECENT_SCORES = [420, 560, 380, 540, 600, 360, 520, 460]
const OLDER_SCORES = [300, 700, 320, 680, 340, 660, 360, 640, 380, 620, 400, 600]
const BOUNDARY_HISTORY = [
  ...RECENT_DAYS.map((d, i) => prior(RECENT_SCORES[i]!, d)),
  ...OLDER_SCORES.map((s, i) => prior(s, 61 + 7 * i)),
]

describe('computeXFactor — gating', () => {
  it('no score when fewer than MIN_LEVEL_POSTS mature priors sit in the level window', () => {
    // only 4 mature priors in the last 60 days
    const priors = history([100, 100, 100, 100], 30)
    const r = computeXFactor(scored(500, 5), priors)
    expect(r.x_score).toBeNull()
    expect(r.x_factor).toBeNull()
    expect(r.creator_level).toBeNull()
    expect(r.x_provisional).toBe(0)
  })

  it('no score when fewer than MIN_SPREAD_POSTS mature priors sit in the spread window', () => {
    // 10 mature priors: passes the level floor (>=5) but not the spread floor (>=15)
    const priors = history(Array<number>(10).fill(200), 40)
    const r = computeXFactor(scored(500, 5), priors)
    expect(r.x_score).toBeNull()
    expect(r.creator_spread).toBeNull()
  })

  it('no score when the spread window has enough posts but yields fewer than MIN_RESIDUALS residuals', () => {
    // 17 mature priors in the spread window: residuals = 17 - LEVEL_POSTS(10) = 7 (< MIN_RESIDUALS 8).
    const priors = history(Array.from({ length: 17 }, (_, i) => 100 + i * 10), 60)
    const r = computeXFactor(scored(500, 5), priors)
    expect(r.x_score).toBeNull()
    expect(r.creator_spread).toBeNull()
  })

  it('a prior with a null measured_at is treated as immature and excluded', () => {
    const base = computeXFactor(scored(3000, 5), BOUNDARY_HISTORY)
    // A giant prior whose measurement instant is unknown cannot be verified mature -> dropped.
    const withUnverifiable = [...BOUNDARY_HISTORY, { weighted_score: 1_000_000, posted_at: daysBefore(20), measured_at: null }]
    const r = computeXFactor(scored(3000, 5), withUnverifiable)
    expect(r.creator_level).toBeCloseTo(base.creator_level!, 9)
    expect(r.x_score).toBeCloseTo(base.x_score!, 9)
  })

  it('falls back to scraped_at for the scored post when measured_at is null', () => {
    // measured_at null, scraped_at only 0.5 day after posting -> provisional, no score.
    const young = { weighted_score: 5000, posted_at: T, measured_at: null, scraped_at: iso(Tms + 0.5 * DAY) }
    const r = computeXFactor(young, CLEAN_HISTORY)
    expect(r.x_score).toBeNull()
    expect(r.x_provisional).toBe(1)
    // measured_at null, scraped_at 5 days after posting -> mature, scores normally.
    const mature = { weighted_score: 5000, posted_at: T, measured_at: null, scraped_at: iso(Tms + 5 * DAY) }
    const rm = computeXFactor(mature, CLEAN_HISTORY)
    expect(rm.x_score).not.toBeNull()
    expect(rm.x_provisional).toBe(0)
  })

  it('excludes immature priors from BOTH level and spread — a young 100k-point post does not move the level', () => {
    const base = computeXFactor(scored(5000, 5), CLEAN_HISTORY)
    // Insert a giant but IMMATURE prior (measured only 1 day after posting) inside both windows.
    const withYoungGiant = [...CLEAN_HISTORY, prior(100_000, 20, 1)]
    const r = computeXFactor(scored(5000, 5), withYoungGiant)
    expect(r.creator_level).toBeCloseTo(base.creator_level!, 9)
    expect(r.x_score).toBeCloseTo(base.x_score!, 9)
  })

  it('excludes the post itself, priors at/after T, and a prior exactly 180 days before T (strict spread edge)', () => {
    const base = computeXFactor(scored(3000, 5), BOUNDARY_HISTORY)
    const polluted = [
      ...BOUNDARY_HISTORY,
      prior(9_000_000, -1), // one day AFTER T (future) -> excluded
      { weighted_score: 9_000_000, posted_at: T, measured_at: daysBefore(-3) }, // exactly at T -> excluded
      prior(9_000_000, 180), // exactly at the spread lower bound -> excluded (strict)
    ]
    const r = computeXFactor(scored(3000, 5), polluted)
    expect(r.creator_level).toBeCloseTo(base.creator_level!, 9)
    expect(r.creator_spread).toBeCloseTo(base.creator_spread!, 9)
    expect(r.x_score).toBeCloseTo(base.x_score!, 9)
  })

  it('a prior exactly 60 days before T is excluded from the level (strict level edge)', () => {
    const base = computeXFactor(scored(3000, 5), BOUNDARY_HISTORY)
    // A giant at exactly 60d is inside the 180d spread window (so spread legitimately shifts) but is
    // excluded from the 60d level window by the strict edge — the level median must not move.
    const r = computeXFactor(scored(3000, 5), [...BOUNDARY_HISTORY, prior(9_000_000, 60)])
    expect(r.creator_level).toBeCloseTo(base.creator_level!, 9)
  })

  it('level uses only the last LEVEL_POSTS mature priors — an 11th, older post does not move the median', () => {
    const base = computeXFactor(scored(5000, 5), CLEAN_HISTORY)
    // An extra older mature prior with an extreme score, still inside the 60d level window but NOT
    // among the 10 most recent, so slice(-LEVEL_POSTS) drops it and the level is unchanged.
    const withOlder = [prior(1, 45), ...CLEAN_HISTORY]
    const r = computeXFactor(scored(5000, 5), withOlder)
    expect(r.creator_level).toBeCloseTo(base.creator_level!, 9)
    expect(LEVEL_POSTS).toBe(10)
  })
})

describe('computeXFactor — robustness', () => {
  it('one giant prior does not move level, and only modestly moves spread (median/MAD property)', () => {
    const base = computeXFactor(scored(3000, 5), BOUNDARY_HISTORY)
    // Turn one older mature prior into a 1M-point giant (kept mature, inside the spread window).
    const withGiant = BOUNDARY_HISTORY.map((p, i) => (i === 12 ? prior(1_000_000, 82) : p))
    const r = computeXFactor(scored(3000, 5), withGiant)
    expect(r.creator_level).toBeCloseTo(base.creator_level!, 9) // level is a median of recent -> identical
    // spread is a MAD -> a single outlier moves it only a little, never explodes it
    expect(Math.abs(r.creator_spread! - base.creator_spread!)).toBeLessThan(0.5)
  })

  it('detrending flattens a steadily-growing history: residuals near 0, small spread', () => {
    // Audience doubles every 10 posts. Undetrended, the recent posts would look like huge outliers
    // against the smaller past self; detrended, each is compared to its own recent level -> ~0.
    const scores = Array.from({ length: 30 }, (_, i) => 100 * 2 ** Math.floor(i / 10))
    const priors = history(scores, 40)
    const r = computeXFactor(scored(scores[29]! * 1.1, 5), priors)
    expect(r.creator_spread).not.toBeNull()
    // Detrended spread stays modest; the raw lg-range of the history spans ln(100)..ln(1600) ~ 2.8.
    expect(r.creator_spread!).toBeLessThan(0.6)
  })

  it('applies the spread floor when every prior is identical: x_score is finite and floored', () => {
    // 18 identical priors -> MAD of residuals is 0 -> spread = SPREAD_FLOOR.
    const priors = history(Array<number>(18).fill(200), 40)
    const r = computeXFactor(scored(1000, 5), priors)
    expect(Number.isFinite(r.x_score!)).toBe(true)
    expect(r.creator_spread).toBe(SPREAD_FLOOR)
    expect(r.x_score).toBeCloseTo((lg(1000) - lg(200)) / SPREAD_FLOOR, 9)
  })
})

describe('computeXFactor — provisional', () => {
  it('age < 1 day: nulls, x_provisional = 1 (no number shown)', () => {
    const r = computeXFactor(scored(5000, 0.5), CLEAN_HISTORY)
    expect(r.x_score).toBeNull()
    expect(r.x_factor).toBeNull()
    expect(r.x_provisional).toBe(1)
  })

  it('1 <= age < 3 days: computes both scores, x_provisional = 1', () => {
    const r = computeXFactor(scored(5000, 2), CLEAN_HISTORY)
    expect(r.x_score).not.toBeNull()
    expect(r.x_factor).not.toBeNull()
    expect(r.x_provisional).toBe(1)
  })

  it('age >= 3 days: x_provisional = 0', () => {
    const r = computeXFactor(scored(5000, 3), CLEAN_HISTORY)
    expect(r.x_provisional).toBe(0)
  })

  it('a post with no score for lack of history is not provisional (x_provisional = 0, null scores)', () => {
    const r = computeXFactor(scored(5000, 5), history([100, 100, 100], 20))
    expect(r.x_score).toBeNull()
    expect(r.x_provisional).toBe(0)
  })
})

describe('computeXFactor — x_factor ratio', () => {
  it('x_factor = weighted_score / (exp(level) - 1)', () => {
    const r = computeXFactor(scored(5000, 5), CLEAN_HISTORY)
    // creator_level = 1000, so x_factor = 5000 / 1000 = 5
    expect(r.x_factor).toBeCloseTo(5, 6)
  })

  it('x_factor is null when the level is 0 (all priors zero-scored)', () => {
    const priors = history(Array<number>(18).fill(0), 40)
    const r = computeXFactor(scored(0, 5), priors)
    expect(r.creator_level).toBe(0)
    expect(r.x_factor).toBeNull()
  })
})

describe('computeXFactor — worked numeric example', () => {
  // Hand-checkable construction:
  //  - 8 mature priors @ weighted_score 100, then 10 mature priors @ 1000, all inside both windows.
  //  - level = median of the last 10 lg-scores = lg(1000) = ln(1001).
  //  - creator_level = exp(level) - 1 = 1000.
  //  - detrended residuals (i = 10..17) are [d, d, d/2, d/2, 0, 0, 0, 0] with d = ln(1001) - ln(101);
  //    their median is d/4 and the MAD of them is d/4, so spread = 1.4826 * d/4.
  //  - the scored post has weighted_score 5000, measured on day 5 (mature).
  const d = lg(1000) - lg(100)
  const expectedLevel = lg(1000)
  const expectedSpread = 1.4826 * (d / 4)
  const expectedXScore = (lg(5000) - expectedLevel) / expectedSpread

  it('matches the hand-computed level, spread, x_score, x_factor', () => {
    const r = computeXFactor(scored(5000, 5), CLEAN_HISTORY)
    expect(r.creator_level).toBeCloseTo(1000, 6)
    expect(r.creator_spread).toBeCloseTo(expectedSpread, 9)
    expect(r.x_score).toBeCloseTo(expectedXScore, 9)
    expect(r.x_factor).toBeCloseTo(5, 6)
    expect(r.x_provisional).toBe(0)
  })
})
