import { describe, expect, it } from 'vitest'
import { isLikelyNonEnglish } from '@/lib/pure/lang'

describe('isLikelyNonEnglish', () => {
  it('passes plain English', () => {
    expect(isLikelyNonEnglish('Hello world, this is an English post!')).toBe(false)
  })

  it('passes accented Latin text (still Latin script)', () => {
    expect(isLikelyNonEnglish('café résumé naïve über')).toBe(false)
  })

  it('flags predominantly CJK text', () => {
    expect(isLikelyNonEnglish('你好世界这是一个测试')).toBe(true)
  })

  it('flags Cyrillic text', () => {
    expect(isLikelyNonEnglish('привет мир как дела')).toBe(true)
  })

  it('flags Arabic text', () => {
    expect(isLikelyNonEnglish('مرحبا بالعالم هذا اختبار')).toBe(true)
  })

  it('passes text that is mostly English with a few non-Latin characters', () => {
    expect(isLikelyNonEnglish('Great meeting everyone at the event 你好 today')).toBe(false)
  })

  it('returns false for null / undefined / empty / letterless input', () => {
    expect(isLikelyNonEnglish(null)).toBe(false)
    expect(isLikelyNonEnglish(undefined)).toBe(false)
    expect(isLikelyNonEnglish('')).toBe(false)
    expect(isLikelyNonEnglish('   ')).toBe(false)
    expect(isLikelyNonEnglish('123 !!! ###')).toBe(false)
  })
})
