// Layer 0 — human "last scraped" labels (PRD §11.8). Zero I/O; `now` is injected so it never flakes.
import { describe, expect, it } from 'vitest'
import { formatAgo } from '@/lib/pure/relative-time'

const now = new Date('2026-09-07T12:00:00.000Z')
const ago = (iso: string): string => formatAgo(iso, now)

describe('formatAgo', () => {
  it('says never for a missing timestamp', () => {
    expect(formatAgo(null, now)).toBe('never')
    expect(formatAgo(undefined, now)).toBe('never')
  })

  it('says never for an unparseable timestamp rather than NaN', () => {
    expect(ago('not-a-date')).toBe('never')
  })

  it('collapses anything under a minute to just now', () => {
    expect(ago('2026-09-07T11:59:30.000Z')).toBe('just now')
  })

  it('uses the largest whole unit that fits, singular and plural', () => {
    expect(ago('2026-09-07T11:55:00.000Z')).toBe('5 minutes ago')
    expect(ago('2026-09-07T11:00:00.000Z')).toBe('1 hour ago')
    expect(ago('2026-09-07T09:00:00.000Z')).toBe('3 hours ago')
    expect(ago('2026-09-06T12:00:00.000Z')).toBe('1 day ago')
    expect(ago('2026-09-04T12:00:00.000Z')).toBe('3 days ago')
    expect(ago('2026-08-24T12:00:00.000Z')).toBe('2 weeks ago')
    expect(ago('2026-06-07T12:00:00.000Z')).toBe('3 months ago')
  })

  it('treats a future timestamp as just now instead of a negative age', () => {
    expect(ago('2026-09-08T12:00:00.000Z')).toBe('just now')
  })
})

describe('daysSince', () => {
  it('is null when there is no timestamp, so callers can branch on "never"', async () => {
    const { daysSince } = await import('@/lib/pure/relative-time')
    expect(daysSince(null, now)).toBeNull()
    expect(daysSince('2026-09-04T12:00:00.000Z', now)).toBe(3)
    expect(daysSince('2026-09-07T11:00:00.000Z', now)).toBe(0)
  })
})
