import { describe, expect, it } from 'vitest'
import { xFactorBadge } from '@/lib/pure/badge'

describe('xFactorBadge', () => {
  it('is a green 🔥 badge at or above 2x', () => {
    expect(xFactorBadge(3)).toEqual({ tone: 'green', emoji: '🔥', label: '3.0×' })
    expect(xFactorBadge(2).tone).toBe('green') // inclusive lower bound
  })

  it('is a gray badge in the 0.5x–2x band', () => {
    expect(xFactorBadge(1)).toEqual({ tone: 'gray', emoji: '', label: '1.0×' })
    expect(xFactorBadge(0.5).tone).toBe('gray') // inclusive lower bound
    expect(xFactorBadge(1.99).tone).toBe('gray')
  })

  it('is a red badge below 0.5x', () => {
    expect(xFactorBadge(0.3)).toEqual({ tone: 'red', emoji: '', label: '0.3×' })
  })

  it('is a hidden (none) badge when x_factor is null', () => {
    expect(xFactorBadge(null)).toEqual({ tone: 'none', emoji: '', label: null })
  })
})
