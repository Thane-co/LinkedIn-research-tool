// Layer 2 — settings accessor used by all adapters (PRD §6.4). The ONLY way keys reach code.
// Never read keys from process.env; never log key values.
// TDD: defaults merged over stored rows; getKey returns undefined when unset.

import type { SettingsMap } from '@/lib/types'

/** All settings: SETTINGS_DEFAULTS merged under stored rows (stored wins). */
export function getSettings(): SettingsMap {
  throw new Error('Not implemented — see PRD §6.4')
}

/** Single key, or undefined/empty when unset. */
export function getKey(_name: string): string | undefined {
  throw new Error('Not implemented — see PRD §6.4')
}

/** Partial upsert (empty string clears). */
export function setSettings(_partial: SettingsMap): void {
  throw new Error('Not implemented — see PRD §6.4')
}

/** Which providers have their required key present (used to gate features, PRD §11.4). */
export function readiness(): { apify: boolean; voyage: boolean; anthropic: boolean } {
  throw new Error('Not implemented — see PRD §11.4/§14')
}
