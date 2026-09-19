import { describe, expect, it } from 'vitest'
import { xFactorBadge } from '@/lib/pure/badge'
import { LOW_Z, NOTABLE_Z, RARE_Z } from '@/lib/config'

describe('xFactorBadge (x-factor v2)', () => {
  it('is a green 🔥 badge at or above RARE_Z, labelled with sigma and ratio', () => {
    expect(xFactorBadge(3.4, 4.2, 0)).toEqual({ tone: 'green', emoji: '🔥', label: '3.4σ · 4.2×' })
    expect(xFactorBadge(RARE_Z, 3, 0).tone).toBe('green') // inclusive lower bound
  })

  it('is an amber badge in the [NOTABLE_Z, RARE_Z) band', () => {
    expect(xFactorBadge(1.8, 2, 0)).toEqual({ tone: 'amber', emoji: '', label: '1.8σ · 2.0×' })
    expect(xFactorBadge(NOTABLE_Z, 1.5, 0).tone).toBe('amber') // inclusive lower bound
    expect(xFactorBadge(RARE_Z - 0.01, 1, 0).tone).toBe('amber') // just under rare
  })

  it('is a gray badge between LOW_Z (exclusive) and NOTABLE_Z (exclusive)', () => {
    expect(xFactorBadge(0, 1, 0)).toEqual({ tone: 'gray', emoji: '', label: '0.0σ · 1.0×' })
    expect(xFactorBadge(NOTABLE_Z - 0.01, 1, 0).tone).toBe('gray')
    expect(xFactorBadge(LOW_Z + 0.01, 0.5, 0).tone).toBe('gray')
  })

  it('is a red badge at or below LOW_Z', () => {
    expect(xFactorBadge(-2, 0.3, 0)).toEqual({ tone: 'red', emoji: '', label: '-2.0σ · 0.3×' })
    expect(xFactorBadge(LOW_Z, 0.4, 0).tone).toBe('red') // inclusive upper bound
  })

  it('omits the ratio from the label when x_factor is null', () => {
    expect(xFactorBadge(2.0, null, 0)).toEqual({ tone: 'amber', emoji: '', label: '2.0σ' })
  })

  it('shows a hollow "new" pill for a provisional post with no score yet', () => {
    expect(xFactorBadge(null, null, 1)).toEqual({ tone: 'pending', emoji: '', label: 'new' })
  })

  it('shows nothing for a post with no score and not provisional (no history)', () => {
    expect(xFactorBadge(null, null, 0)).toEqual({ tone: 'none', emoji: '', label: null })
  })

  it('appends "(day N)" to the label while the post is provisional', () => {
    expect(xFactorBadge(2.6, 3.1, 1, 2)).toEqual({ tone: 'green', emoji: '🔥', label: '2.6σ · 3.1× (day 2)' })
    // provisional but no age given: no day tag
    expect(xFactorBadge(2.6, 3.1, 1).label).toBe('2.6σ · 3.1×')
    // not provisional: never a day tag even if age passed
    expect(xFactorBadge(2.6, 3.1, 0, 5).label).toBe('2.6σ · 3.1×')
  })
})
