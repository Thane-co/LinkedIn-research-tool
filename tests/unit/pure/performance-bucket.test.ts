import { describe, expect, it } from 'vitest'
import { performanceBucket } from '@/lib/pure/performance-bucket'

// Basia's own thresholds on LinkedIn likes. Boundaries are inclusive on the lower bound (spec
// content-loop): <200 flop · 200-499 ok · 500-749 good · 750-999 great · >=1000 viral.
describe('performanceBucket', () => {
  it('buckets every boundary inclusively on the lower bound', () => {
    expect(performanceBucket(0)).toBe('flop')
    expect(performanceBucket(199)).toBe('flop')
    expect(performanceBucket(200)).toBe('ok')
    expect(performanceBucket(499)).toBe('ok')
    expect(performanceBucket(500)).toBe('good')
    expect(performanceBucket(749)).toBe('good')
    expect(performanceBucket(750)).toBe('great')
    expect(performanceBucket(999)).toBe('great')
    expect(performanceBucket(1000)).toBe('viral')
    expect(performanceBucket(1_000_000)).toBe('viral')
  })
})
