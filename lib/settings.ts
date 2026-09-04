// Layer 2 — settings accessor used by all adapters (PRD §6.4). The ONLY way keys reach code.
// Never read keys from process.env; never log key values.

import { readAllSettings, writeSettings } from '@/lib/db/settings.repo'
import { SETTINGS_DEFAULTS } from '@/lib/config'
import type { SettingsMap } from '@/lib/types'

/** All settings: SETTINGS_DEFAULTS merged under stored rows (stored wins). */
export function getSettings(): SettingsMap {
  return { ...SETTINGS_DEFAULTS, ...readAllSettings() }
}

/** Single key value, or undefined when unset or explicitly cleared (empty string). */
export function getKey(name: string): string | undefined {
  const value = getSettings()[name]
  return value ? value : undefined
}

/** Partial upsert (empty string clears). */
export function setSettings(partial: SettingsMap): void {
  writeSettings(partial)
}

/** Which providers have their required key present (used to gate features, PRD §11.4).
 *  assemblyai gates only the temporary ig-compare tab, not core Search. */
export function readiness(): { apify: boolean; voyage: boolean; anthropic: boolean; assemblyai: boolean } {
  return {
    apify: getKey('apify_api_token') !== undefined,
    voyage: getKey('voyage_api_key') !== undefined,
    anthropic: getKey('anthropic_api_key') !== undefined,
    assemblyai: getKey('assemblyai_api_key') !== undefined,
  }
}
