import { describe, expect, it } from 'vitest'
import {
  attributeDay,
  dailyDeltas,
  rankLeaderboard,
  windowGrowth,
  type GrowthEntry,
  type Snapshot,
} from '@/lib/pure/follower-growth'

const snap = (captured_on: string, followers: number, hour = '06:00'): Snapshot => ({
  captured_on,
  captured_at: `${captured_on}T${hour}:00.000Z`,
  followers,
})

describe('dailyDeltas', () => {
  it('returns one delta per consecutive pair, oldest first', () => {
    const out = dailyDeltas([snap('2026-09-01', 1000), snap('2026-09-02', 1050), snap('2026-09-03', 1100)])
    expect(out).toEqual([
      { captured_on: '2026-09-02', followers: 1050, gained: 50, percent: 5, gap_days: 1, per_day: 50 },
      { captured_on: '2026-09-03', followers: 1100, gained: 50, percent: 50 / 1050 * 100, gap_days: 1, per_day: 50 },
    ])
  })

  it('sorts unordered input before differencing', () => {
    const out = dailyDeltas([snap('2026-09-03', 1100), snap('2026-09-01', 1000), snap('2026-09-02', 1050)])
    expect(out.map((d) => d.captured_on)).toEqual(['2026-09-02', '2026-09-03'])
  })

  it('the first snapshot produces no delta (nothing to compare against)', () => {
    expect(dailyDeltas([snap('2026-09-01', 1000)])).toEqual([])
    expect(dailyDeltas([])).toEqual([])
  })

  it('normalizes a multi-day gap into per_day but keeps the raw gained', () => {
    const d = dailyDeltas([snap('2026-09-01', 1000), snap('2026-09-04', 1300)])[0]!
    expect(d).toMatchObject({ gained: 300, gap_days: 3, per_day: 100 })
  })

  it('measures the gap from captured_at, not the day key, so a shifted capture hour is honest', () => {
    // 06:00 -> next day 18:00 is 1.5 days of real growth, not 1.
    const d = dailyDeltas([snap('2026-09-01', 1000, '06:00'), snap('2026-09-02', 1030, '18:00')])[0]!
    expect(d.gap_days).toBe(1.5)
    expect(d.gained).toBe(30)
    expect(d.per_day).toBe(20)
  })

  it('keeps a negative delta (unfollows are real signal, never clamped to 0)', () => {
    const d = dailyDeltas([snap('2026-09-01', 1000), snap('2026-09-02', 940)])[0]!
    expect(d).toMatchObject({ gained: -60, per_day: -60 })
    expect(d.percent).toBeCloseTo(-6)
  })

  it('never divides by a zero-or-negative gap when two captures share an instant', () => {
    // Same captured_at on two day keys should not produce Infinity in per_day.
    const d = dailyDeltas([
      { captured_on: '2026-09-01', captured_at: '2026-09-01T06:00:00.000Z', followers: 1000 },
      { captured_on: '2026-09-02', captured_at: '2026-09-01T06:00:00.000Z', followers: 1060 },
    ])[0]!
    expect(d.gap_days).toBe(1)
    expect(Number.isFinite(d.per_day)).toBe(true)
  })

  it('percent is null when the earlier snapshot was 0 followers (no division by zero)', () => {
    const d = dailyDeltas([snap('2026-09-01', 0), snap('2026-09-02', 25)])[0]!
    expect(d.percent).toBeNull()
  })
})

describe('windowGrowth', () => {
  const series = [
    snap('2026-09-01', 1000),
    snap('2026-09-05', 1200),
    snap('2026-09-08', 1300),
    snap('2026-09-09', 1400),
  ]

  it('compares the newest snapshot against the newest one at or before the window start', () => {
    // asOf 09-09, window 1d -> baseline is 09-08 (1300)
    expect(windowGrowth(series, { windowDays: 1, asOf: '2026-09-09' })).toMatchObject({
      followers: 1400,
      gained: 100,
      baseline_on: '2026-09-08',
    })
  })

  it('falls back to the nearest older snapshot when the exact window start is missing', () => {
    // window 7d from 09-09 starts 09-02; nothing on 09-02, so 09-01 (1000) is used
    expect(windowGrowth(series, { windowDays: 7, asOf: '2026-09-09' })).toMatchObject({
      gained: 400,
      baseline_on: '2026-09-01',
    })
  })

  it('reports the true span so a fallback baseline is never passed off as an exact window', () => {
    const g = windowGrowth(series, { windowDays: 7, asOf: '2026-09-09' })
    expect(g?.gap_days).toBe(8) // 09-01 -> 09-09, not the requested 7
  })

  it('returns null when only one snapshot exists — a creator with no history shows a dash, not a zero', () => {
    expect(windowGrowth([snap('2026-09-09', 1400)], { windowDays: 7, asOf: '2026-09-09' })).toBeNull()
    expect(windowGrowth([], { windowDays: 7, asOf: '2026-09-09' })).toBeNull()
  })

  it('marks the row stale when the newest snapshot predates asOf by more than a day', () => {
    const stale = windowGrowth([snap('2026-09-01', 1000), snap('2026-09-05', 1200)], {
      windowDays: 7,
      asOf: '2026-09-09',
    })
    expect(stale?.stale).toBe(true)
    expect(windowGrowth(series, { windowDays: 7, asOf: '2026-09-09' })?.stale).toBe(false)
  })

  it('falls back to the oldest snapshot when the window opens before the series begins', () => {
    // 30d window from 09-09 opens 08-10; the series starts 09-01, so 09-01 is the only baseline.
    const g = windowGrowth(series, { windowDays: 30, asOf: '2026-09-09' })
    expect(g).toMatchObject({ baseline_on: '2026-09-01', gained: 400 })
  })

  it('marks the row approximate when the baseline is materially older than the window', () => {
    // A 1d board whose only baseline is 8 days old is NOT a one-day gain. Flag it, do not hide it.
    const g = windowGrowth([snap('2026-09-01', 1000), snap('2026-09-09', 1400)], {
      windowDays: 1,
      asOf: '2026-09-09',
    })
    expect(g).toMatchObject({ gained: 400, gap_days: 8, approx: true })
  })

  it('does not flag a baseline within tolerance of the window as approximate', () => {
    const g = windowGrowth(series, { windowDays: 1, asOf: '2026-09-09' })
    expect(g?.approx).toBe(false)
  })

  it('returns null for a window too short to contain a second measurement', () => {
    // Not a fabricated 0: the latest snapshot would be its own baseline, which measures nothing.
    expect(windowGrowth(series, { windowDays: 0, asOf: '2026-09-09' })).toBeNull()
  })

  it('ignores snapshots newer than asOf', () => {
    const g = windowGrowth([...series, snap('2026-09-10', 9999)], { windowDays: 1, asOf: '2026-09-09' })
    expect(g?.followers).toBe(1400)
  })
})

describe('rankLeaderboard', () => {
  const entry = (author_id: string, followers: number, gained: number | null): GrowthEntry => ({
    author_id,
    display_name: author_id,
    avatar_url: null,
    followers,
    gained,
    percent: gained === null || followers - gained === 0 ? null : (gained / (followers - gained)) * 100,
    stale: false,
    approx: false,
    posts: 0,
    best_x_score: null,
  })

  it('ranks the absolute board by followers gained, biggest first', () => {
    const { absolute } = rankLeaderboard([entry('a', 5000, 10), entry('b', 5000, 900), entry('c', 5000, 100)], {
      percentFloor: 10_000,
    })
    expect(absolute.map((r) => r.author_id)).toEqual(['b', 'c', 'a'])
  })

  it('lists EVERY creator on the absolute board, including ones that lost or have no data', () => {
    const { absolute } = rankLeaderboard([entry('up', 5000, 50), entry('down', 5000, -80), entry('new', 5000, null)], {
      percentFloor: 10_000,
    })
    expect(absolute).toHaveLength(3)
    expect(absolute.map((r) => r.author_id)).toEqual(['up', 'down', 'new'])
  })

  it('sorts creators with no delta last, after even the biggest loser', () => {
    const { absolute } = rankLeaderboard([entry('new', 5000, null), entry('down', 5000, -500)], {
      percentFloor: 10_000,
    })
    expect(absolute.map((r) => r.author_id)).toEqual(['down', 'new'])
  })

  it('excludes accounts under the follower floor from the PERCENT board only', () => {
    const small = entry('small', 500, 100) // +25%, would top an unfloored board
    const big = entry('big', 50_000, 500) // +1%
    const { absolute, percent } = rankLeaderboard([small, big], { percentFloor: 10_000 })
    expect(absolute.map((r) => r.author_id)).toEqual(['big', 'small']) // 500 > 100
    expect(percent.map((r) => r.author_id)).toEqual(['big']) // small is floored out
  })

  it('applies the floor to the CURRENT follower count, at or above the floor inclusive', () => {
    const { percent } = rankLeaderboard([entry('exactly', 10_000, 100)], { percentFloor: 10_000 })
    expect(percent.map((r) => r.author_id)).toEqual(['exactly'])
  })

  it('omits null-percent rows from the percent board', () => {
    const { percent } = rankLeaderboard([entry('nodata', 50_000, null)], { percentFloor: 10_000 })
    expect(percent).toEqual([])
  })

  it('breaks ties deterministically by follower count, then author_id', () => {
    const { absolute } = rankLeaderboard([entry('zeta', 100, 10), entry('alpha', 100, 10), entry('big', 900, 10)], {
      percentFloor: 10_000,
    })
    expect(absolute.map((r) => r.author_id)).toEqual(['big', 'alpha', 'zeta'])
  })

  it('orders two unmeasured creators by author_id so the board never reshuffles between loads', () => {
    const { absolute } = rankLeaderboard([entry('zeta', 5000, null), entry('alpha', 5000, null)], {
      percentFloor: 10_000,
    })
    expect(absolute.map((r) => r.author_id)).toEqual(['alpha', 'zeta'])
  })

  it('assigns 1-based ranks per board independently', () => {
    const { absolute, percent } = rankLeaderboard([entry('small', 500, 400), entry('big', 50_000, 300)], {
      percentFloor: 10_000,
    })
    expect(absolute.map((r) => r.rank)).toEqual([1, 2])
    expect(percent.map((r) => [r.author_id, r.rank])).toEqual([['big', 1]])
  })
})

describe('attributeDay', () => {
  it('credits the whole day to a single post', () => {
    expect(attributeDay(412, [{ id: 'p1', x_factor: 2.4 }])).toEqual({
      gained: 412,
      post_count: 1,
      shared: false,
      attributable_post_id: 'p1',
    })
  })

  it('refuses to split across multiple posts — the day is shared, no per-post number', () => {
    expect(attributeDay(412, [{ id: 'p1', x_factor: 2.4 }, { id: 'p2', x_factor: 0.8 }])).toEqual({
      gained: 412,
      post_count: 2,
      shared: true,
      attributable_post_id: null,
    })
  })

  it('keeps growth on a day with no posts (off-platform or an older post catching fire)', () => {
    expect(attributeDay(412, [])).toEqual({
      gained: 412,
      post_count: 0,
      shared: false,
      attributable_post_id: null,
    })
  })
})
