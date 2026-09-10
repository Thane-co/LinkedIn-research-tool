import { describe, expect, it } from 'vitest'
import {
  ageInDays,
  engagementDeltas,
  summarizePostGrowth,
  type PostSnapshot,
} from '@/lib/pure/post-growth'

const snap = (captured_on: string, likes: number, comments = 0, shares = 0): PostSnapshot => ({
  captured_on,
  captured_at: `${captured_on}T06:00:00.000Z`,
  likes,
  comments,
  shares,
})

describe('engagementDeltas', () => {
  it('returns one delta per consecutive pair, oldest first', () => {
    const out = engagementDeltas([snap('2026-09-08', 100), snap('2026-09-09', 180), snap('2026-09-10', 200)])
    expect(out.map((d) => d.gained)).toEqual([80, 20])
    expect(out.map((d) => d.captured_on)).toEqual(['2026-09-09', '2026-09-10'])
  })

  it('weights the delta the same way x-factor does (likes 1, comments 3, shares 5)', () => {
    const out = engagementDeltas([snap('2026-09-08', 0, 0, 0), snap('2026-09-09', 10, 2, 1)])
    expect(out[0]).toMatchObject({ gained: 13, weighted_gained: 10 + 6 + 5 })
  })

  it('sorts unordered input before differencing', () => {
    const out = engagementDeltas([snap('2026-09-10', 200), snap('2026-09-08', 100), snap('2026-09-09', 180)])
    expect(out.map((d) => d.gained)).toEqual([80, 20])
  })

  it('yields nothing from a single snapshot — one measurement is not a curve', () => {
    expect(engagementDeltas([snap('2026-09-08', 100)])).toEqual([])
    expect(engagementDeltas([])).toEqual([])
  })

  it('keeps a negative delta rather than clamping — LinkedIn revises counts down', () => {
    const out = engagementDeltas([snap('2026-09-08', 100), snap('2026-09-09', 94)])
    expect(out[0]?.gained).toBe(-6)
  })

  it('reports the share of total engagement added on each day', () => {
    const out = engagementDeltas([snap('2026-09-08', 100), snap('2026-09-09', 150)])
    expect(out[0]?.pct_of_total).toBeCloseTo(50 / 150 * 100)
  })
})

describe('ageInDays', () => {
  it('measures a post age from posted_at to the capture instant', () => {
    expect(ageInDays('2026-09-08T06:00:00.000Z', '2026-09-10T06:00:00.000Z')).toBe(2)
  })

  it('rounds a partial day rather than truncating it to zero', () => {
    expect(ageInDays('2026-09-09T18:00:00.000Z', '2026-09-10T06:00:00.000Z')).toBe(0.5)
  })
})

describe('edge cases that must not produce fake numbers', () => {
  it('clamps a negative age to 0 rather than reporting time running backwards', () => {
    expect(ageInDays('2026-09-10T06:00:00.000Z', '2026-09-08T06:00:00.000Z')).toBe(0)
  })

  it('gives a zero-engagement step a null share instead of dividing by zero', () => {
    const out = engagementDeltas([snap('2026-09-08', 0), snap('2026-09-09', 0)])
    expect(out[0]?.pct_of_total).toBeNull()
  })

  it('treats a post stuck at zero engagement as not climbing, with no late-share figure', () => {
    const s = summarizePostGrowth('2026-09-07T09:00:00.000Z', [snap('2026-09-08', 0), snap('2026-09-09', 0)])
    expect(s.still_climbing).toBe(false)
    expect(s.pct_after_day1).toBeNull()
  })
})

describe('summarizePostGrowth', () => {
  const posted = '2026-09-07T09:00:00.000Z'

  it('gives day-1, day-2 and day-3 totals so posts can be compared at equal age', () => {
    const s = summarizePostGrowth(posted, [
      snap('2026-09-08', 100), // ~1d old
      snap('2026-09-09', 160), // ~2d
      snap('2026-09-10', 175), // ~3d
    ])
    expect(s.day1).toBe(100)
    expect(s.day2).toBe(160)
    expect(s.day3).toBe(175)
  })

  it('marks a post still climbing when the latest day added a meaningful share', () => {
    const s = summarizePostGrowth(posted, [snap('2026-09-08', 100), snap('2026-09-09', 200)])
    expect(s.still_climbing).toBe(true)
  })

  it('marks a post finished when the latest day barely moved', () => {
    const s = summarizePostGrowth(posted, [snap('2026-09-08', 100), snap('2026-09-09', 101)])
    expect(s.still_climbing).toBe(false)
  })

  it('reports what fraction of total engagement arrived after the first day', () => {
    // 100 on day 1, 100 more later -> half the engagement is late
    const s = summarizePostGrowth(posted, [snap('2026-09-08', 100), snap('2026-09-10', 200)])
    expect(s.pct_after_day1).toBeCloseTo(50)
  })

  it('leaves later days null when the post is too young to have them', () => {
    const s = summarizePostGrowth(posted, [snap('2026-09-08', 100)])
    expect(s).toMatchObject({ day1: 100, day2: null, day3: null })
  })

  it('is all-null for a post never captured, never a fabricated zero', () => {
    expect(summarizePostGrowth(posted, [])).toMatchObject({
      day1: null,
      day2: null,
      day3: null,
      still_climbing: false,
      pct_after_day1: null,
    })
  })

  it('picks the capture closest to each day boundary, not merely the first one past it', () => {
    // A gap means the day-2 slot is best served by the 2.1d capture, not the 3.9d one.
    const s = summarizePostGrowth(posted, [
      { captured_on: '2026-09-09', captured_at: '2026-09-09T11:00:00.000Z', likes: 150, comments: 0, shares: 0 },
      { captured_on: '2026-09-11', captured_at: '2026-09-11T03:00:00.000Z', likes: 300, comments: 0, shares: 0 },
    ])
    expect(s.day2).toBe(150)
  })
})
