// Layer 0 — relative time labels (PRD §11.8). Zero I/O.
// `now` is a parameter, never Date.now() inside, so the output is deterministic and testable.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY

const UNITS: [ms: number, name: string][] = [
  [MONTH, 'month'],
  [WEEK, 'week'],
  [DAY, 'day'],
  [HOUR, 'hour'],
  [MINUTE, 'minute'],
]

/** Milliseconds between `iso` and `now`, or null when the timestamp is absent or unparseable. */
function ageMs(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, now.getTime() - then) // a clock-skewed future timestamp reads as age 0, not negative
}

/** "3 days ago" / "just now" / "never" — the largest whole unit that fits. */
export function formatAgo(iso: string | null | undefined, now: Date): string {
  const age = ageMs(iso, now)
  if (age === null) return 'never'
  for (const [ms, name] of UNITS) {
    const n = Math.floor(age / ms)
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`
  }
  return 'just now'
}

/** Whole days since `iso`, or null when absent — lets the UI suggest a timeframe for the gap. */
export function daysSince(iso: string | null | undefined, now: Date): number | null {
  const age = ageMs(iso, now)
  return age === null ? null : Math.floor(age / DAY)
}
