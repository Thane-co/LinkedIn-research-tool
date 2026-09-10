// Layer 0 — post engagement-growth math (PRD §22). Zero I/O. 100% coverage required.
//
// Follower tracking (§21) answers "is this creator growing?". This answers the different question
// "how did THIS post grow after it was published?" — whether engagement kept compounding past the
// first day or spiked and died.
//
// Two rules carried over from §21, for the same reasons:
//   - A missing measurement is null, never 0. A post captured once has no curve yet.
//   - Deltas are measured between real `captured_at` instants, never day keys.
//
// One rule specific to posts: DAY SLOTS ARE MEASURED FROM `posted_at`, NOT FROM THE CAPTURE DATE.
// Comparing two posts at "day 2" only means something if day 2 is 2 days after each was published.
// A post published at 09:00 and one published at 23:00 the same evening are a day apart in maturity
// while sharing a capture date.

import { WEIGHTS } from '@/lib/config'

const DAY_MS = 24 * 60 * 60 * 1000

export interface PostSnapshot {
  captured_on: string // 'YYYY-MM-DD' UTC day key
  captured_at: string // ISO instant — every elapsed-time calculation uses this
  likes: number
  comments: number
  shares: number
}

const total = (s: PostSnapshot): number => s.likes + s.comments + s.shares
const weighted = (s: PostSnapshot): number =>
  s.likes * WEIGHTS.likes + s.comments * WEIGHTS.comments + s.shares * WEIGHTS.shares

/** Elapsed days between two instants, to one decimal. Negative spans clamp to 0. */
export function ageInDays(fromISO: string, toISO: string): number {
  const raw = (Date.parse(toISO) - Date.parse(fromISO)) / DAY_MS
  return raw > 0 ? Math.round(raw * 10) / 10 : 0
}

export interface EngagementDelta {
  captured_on: string
  total: number
  gained: number
  weighted_gained: number
  pct_of_total: number | null // how much of the post's engagement-to-date arrived in this step
}

const byCapturedAt = (a: PostSnapshot, b: PostSnapshot): number => a.captured_at.localeCompare(b.captured_at)

/**
 * One delta per consecutive pair, oldest first. Negative deltas are preserved: LinkedIn revises
 * reaction counts downward (deleted accounts, removed reactions), and clamping that to 0 would show
 * a flat line where the data actually moved.
 */
export function engagementDeltas(snapshots: PostSnapshot[]): EngagementDelta[] {
  const sorted = [...snapshots].sort(byCapturedAt)
  const out: EngagementDelta[] = []

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const curr = sorted[i]!
    const runningTotal = total(curr)
    const gained = runningTotal - total(prev)
    out.push({
      captured_on: curr.captured_on,
      total: runningTotal,
      gained,
      weighted_gained: weighted(curr) - weighted(prev),
      pct_of_total: runningTotal === 0 ? null : (gained / runningTotal) * 100,
    })
  }
  return out
}

/** The snapshot whose age is closest to `targetDay`, or null when none is within half a day. */
function nearestToDay(postedAt: string, sorted: PostSnapshot[], targetDay: number): PostSnapshot | null {
  let best: PostSnapshot | null = null
  let bestGap = Infinity
  for (const s of sorted) {
    const gap = Math.abs(ageInDays(postedAt, s.captured_at) - targetDay)
    if (gap < bestGap) {
      bestGap = gap
      best = s
    }
  }
  // Half a day of tolerance: a daily capture drifting a few hours still fills its slot, but a
  // two-day gap never gets to masquerade as the missing day.
  return bestGap <= 0.5 ? best : null
}

/** A step this small is measurement noise, not a post still finding an audience. */
const STILL_CLIMBING_PCT = 5

export interface PostGrowthSummary {
  day1: number | null
  day2: number | null
  day3: number | null
  latest_total: number | null
  still_climbing: boolean
  /** Share of all engagement that arrived AFTER the first day — the compounding signal. */
  pct_after_day1: number | null
}

/**
 * Compare posts at equal maturity. `day1`/`day2`/`day3` are total engagement at ~1, ~2 and ~3 days
 * of age, each filled from the capture nearest that age; a slot with no capture within half a day
 * stays null rather than borrowing a distant one.
 *
 * `pct_after_day1` is the interesting number: a post that took 80% of its engagement after day one
 * behaves completely differently from one that took 95% on the first afternoon, even when the two
 * finish on the same total.
 */
export function summarizePostGrowth(postedAt: string, snapshots: PostSnapshot[]): PostGrowthSummary {
  const sorted = [...snapshots].sort(byCapturedAt)
  if (sorted.length === 0) {
    return { day1: null, day2: null, day3: null, latest_total: null, still_climbing: false, pct_after_day1: null }
  }

  const at = (d: number): number | null => {
    const s = nearestToDay(postedAt, sorted, d)
    return s ? total(s) : null
  }

  const day1 = at(1)
  const latest = sorted[sorted.length - 1]!
  const latestTotal = total(latest)

  const deltas = engagementDeltas(sorted)
  const lastDelta = deltas[deltas.length - 1]

  return {
    day1,
    day2: at(2),
    day3: at(3),
    latest_total: latestTotal,
    still_climbing: lastDelta ? (lastDelta.pct_of_total ?? 0) >= STILL_CLIMBING_PCT : false,
    pct_after_day1: day1 === null || latestTotal === 0 ? null : ((latestTotal - day1) / latestTotal) * 100,
  }
}
