import { describe, expect, it } from 'vitest'
import { derivePersonaKey } from '@/lib/pure/persona'

describe('derivePersonaKey', () => {
  it('lowercases and collapses whitespace to a stable key', () => {
    expect(derivePersonaKey('Lara Acosta')).toBe('lara acosta')
    expect(derivePersonaKey('  LARA   Acosta ')).toBe('lara acosta')
  })

  it('drops trailing credentials after the first comma', () => {
    expect(derivePersonaKey('Lara Acosta, PhD')).toBe('lara acosta')
    expect(derivePersonaKey('Dr. Jane Doe, MBA, CFA')).toBe('dr jane doe')
  })

  it('strips diacritics so accented spellings match', () => {
    expect(derivePersonaKey('Léa Café')).toBe('lea cafe')
  })

  it('strips emoji / punctuation and keeps only alphanumerics + spaces', () => {
    expect(derivePersonaKey('🔥 Lara Acosta 🚀')).toBe('lara acosta')
    expect(derivePersonaKey('Chris | Growth')).toBe('chris growth')
  })

  it('two variants of the same name derive the same key (auto-match)', () => {
    expect(derivePersonaKey('Lara Acosta')).toBe(derivePersonaKey('  lara   ACOSTA  '))
  })

  it('returns null for empty / whitespace / punctuation-only / nullish input', () => {
    expect(derivePersonaKey('')).toBeNull()
    expect(derivePersonaKey('   ')).toBeNull()
    expect(derivePersonaKey('@@@ !!!')).toBeNull()
    expect(derivePersonaKey(null)).toBeNull()
    expect(derivePersonaKey(undefined)).toBeNull()
  })
})
