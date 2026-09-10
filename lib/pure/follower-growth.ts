// Layer 0 — follower-growth math (PRD §21). Zero I/O. 100% coverage required.
//
// Turns a creator's raw follower snapshot series into day-over-day deltas, windowed growth, and the
// two champion boards (absolute gain / percentage gain).
//
// Three decisions are load-bearing and must not be quietly re-derived:
//
//   1. THE GAP IS MEASURED FROM `captured_at`, NEVER FROM THE DAY KEY. A snapshot taken at 06:00 and
//      the next at 18:00 covers 1.5 days of real growth. Differencing the date strings would call
//      that "one day" and hand back a 50% overstated daily rate.
//   2. A MISSING DELTA IS `null`, NEVER 0. A creator captured for the first time has not "grown by
//      zero" — the number does not exist yet. Collapsing the two states puts brand-new creators in a
//      dead heat with genuinely flat ones and quietly corrupts the board.
//   3. THE PERCENT FLOOR APPLIES TO THE PERCENT BOARD ONLY. Small accounts still rank on absolute
//      gain; they are excluded from percentage ranking because a 200-follower account gaining 40
//      people posts +20% on noise and would own the board every single day.

import { FOLLOWER_PERCENT_FLOOR, SNAPSHOT_STALE_DAYS } from '@/lib/config'

const DAY_MS = 24 * 60 * 60 * 1000

export interface Snapshot {
  captured_on: string // 'YYYY-MM-DD' UTC day key
  captured_at: string // full ISO-8601 UTC — the real instant, used for every gap calculation
  followers: number
}

export interface DayDelta {
  captured_on: string
  followers: number
  gained: number
  percent: number | null // null when the earlier snapshot was 0 followers
  gap_days: number
  per_day: number
}

/** Percentage change, or null when there is no non-zero base to divide by. */
function pctChange(gained: number, from: number): number | null {
  return from === 0 ? null : (gained / from) * 100
}

/** Elapsed days between two captures, from the real instants. Never 0 (guards the per_day divide). */
function gapDays(fromISO: string, toISO: string): number {
  const raw = (Date.parse(toISO) - Date.parse(fromISO)) / DAY_MS
  return raw > 0 ? raw : 1
}

const byCapturedAt = (a: Snapshot, b: Snapshot): number => a.captured_at.localeCompare(b.captured_at)

/**
 * One delta per consecutive pair, oldest first. The first snapshot yields nothing: there is no
 * earlier number to difference it against.
 */
export function dailyDeltas(snapshots: Snapshot[]): DayDelta[] {
  const sorted = [...snapshots].sort(byCapturedAt)
  const out: DayDelta[] = []

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const curr = sorted[i]!
    const gained = curr.followers - prev.followers
    const gap = gapDays(prev.captured_at, curr.captured_at)
    out.push({
      captured_on: curr.captured_on,
      followers: curr.followers,
      gained,
      percent: pctChange(gained, prev.followers),
      gap_days: gap,
      per_day: gained / gap,
    })
  }
  return out
}

export interface WindowGrowth {
  followers: number
  gained: number
  percent: number | null
  baseline_on: string
  baseline_followers: number
  gap_days: number // the TRUE span, which may exceed windowDays when the baseline fell back
  // True when the baseline is materially older than the window asked for. The gain is real, but it
  // is NOT a gain over `windowDays` — it accumulated over `gap_days`. Set so the UI can say so
  // rather than presenting a two-month climb as today's growth (which is exactly what a freshly
  // seeded series looks like on its first captures).
  approx: boolean
  stale: boolean
}

/** How far past the requested window a baseline may sit before the number stops being that window's. */
const APPROX_TOLERANCE = 1.5

/**
 * Growth over the last `windowDays` as of `asOf` (a 'YYYY-MM-DD' day key).
 *
 * The baseline is the newest snapshot at or before the window start. When that day was never
 * captured, the nearest OLDER snapshot is used and `gap_days` reports the real span — so a 7d board
 * never silently presents an 11-day gain as a 7-day one.
 *
 * Returns null when fewer than two snapshots exist at or before `asOf`.
 */
export function windowGrowth(
  snapshots: Snapshot[],
  { windowDays, asOf }: { windowDays: number; asOf: string },
): WindowGrowth | null {
  const asOfMs = Date.parse(`${asOf}T23:59:59.999Z`)
  const eligible = [...snapshots].filter((s) => Date.parse(s.captured_at) <= asOfMs).sort(byCapturedAt)
  if (eligible.length < 2) return null

  const latest = eligible[eligible.length - 1]!
  const windowStartMs = asOfMs - windowDays * DAY_MS

  // Newest snapshot at or before the window start; if the window opens before the series does,
  // fall back to the oldest snapshot we have.
  const atOrBefore = eligible.filter((s) => Date.parse(s.captured_at) <= windowStartMs)
  const baseline = atOrBefore[atOrBefore.length - 1] ?? eligible[0]!
  // A window so short that the latest snapshot IS the baseline measures nothing. Report null rather
  // than the 0 the subtraction would produce, which would read as "flat" instead of "unmeasurable".
  if (baseline === latest) return null

  const gained = latest.followers - baseline.followers
  const gap = Math.round(gapDays(baseline.captured_at, latest.captured_at))
  return {
    followers: latest.followers,
    gained,
    percent: pctChange(gained, baseline.followers),
    baseline_on: baseline.captured_on,
    baseline_followers: baseline.followers,
    gap_days: gap,
    approx: gap > windowDays * APPROX_TOLERANCE,
    stale: gapDays(latest.captured_at, `${asOf}T23:59:59.999Z`) > SNAPSHOT_STALE_DAYS,
  }
}

// --- leaderboard -----------------------------------------------------------

export interface GrowthEntry {
  author_id: string
  display_name: string | null
  avatar_url: string | null
  followers: number
  gained: number | null // null = not enough history yet, NOT zero growth
  percent: number | null
  stale: boolean
  approx: boolean // the gain spans longer than the requested window (see WindowGrowth.approx)
  posts: number // posts published inside the window
  best_x_factor: number | null
}

export interface RankedEntry extends GrowthEntry {
  rank: number
}

/**
 * Deterministic ordering: by the ranking metric descending, then by follower count descending, then
 * by author_id ascending. Rows with no metric always sort last, below even the worst loser — a
 * creator we have not measured yet is unranked, not bottom-ranked.
 */
function sortByMetric<T extends GrowthEntry>(rows: T[], metric: (r: T) => number | null): T[] {
  return [...rows].sort((a, b) => {
    const av = metric(a)
    const bv = metric(b)
    if (av === null && bv === null) return a.author_id.localeCompare(b.author_id)
    if (av === null) return 1
    if (bv === null) return -1
    if (bv !== av) return bv - av
    if (b.followers !== a.followers) return b.followers - a.followers
    return a.author_id.localeCompare(b.author_id)
  })
}

const withRanks = <T extends GrowthEntry>(rows: T[]): (T & { rank: number })[] =>
  rows.map((r, i) => ({ ...r, rank: i + 1 }))

/**
 * Both champion boards from one pass over the entries.
 *
 * `absolute` carries EVERY creator, including losers and the not-yet-measured, because the board
 * doubles as the roster view. `percent` carries only creators at or above `percentFloor` with a
 * real percentage.
 */
export function rankLeaderboard<T extends GrowthEntry>(
  entries: T[],
  { percentFloor = FOLLOWER_PERCENT_FLOOR }: { percentFloor?: number } = {},
): { absolute: (T & { rank: number })[]; percent: (T & { rank: number })[] } {
  const absolute = withRanks(sortByMetric(entries, (r) => r.gained))
  const eligible = entries.filter((r) => r.followers >= percentFloor && r.percent !== null)
  const percent = withRanks(sortByMetric(eligible, (r) => r.percent))
  return { absolute, percent }
}

// --- post attribution ------------------------------------------------------

export interface DayAttribution {
  gained: number
  post_count: number
  shared: boolean // true when >1 post competed for the same day's growth
  attributable_post_id: string | null // set ONLY when exactly one post owns the day
}

/**
 * Tie a day's follower growth to the posts published that day.
 *
 * With one post the number is clean and belongs to it. With several it is NOT split — there is no
 * honest way to divide a single daily total between three posts, and a made-up split would be
 * indistinguishable from a measurement. The day keeps the number; the posts share the credit.
 * A day with zero posts still reports its growth: that is real signal (an older post catching fire,
 * or an off-platform mention), not an error.
 */
export function attributeDay(gained: number, postsThatDay: { id: string; x_factor: number | null }[]): DayAttribution {
  const only = postsThatDay.length === 1 ? postsThatDay[0]! : null
  return {
    gained,
    post_count: postsThatDay.length,
    shared: postsThatDay.length > 1,
    attributable_post_id: only ? only.id : null,
  }
}
