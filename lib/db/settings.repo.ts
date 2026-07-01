// Layer 2 — key/value settings store (PRD §6.4, §12 step 16). Low-level row access only.
// TDD: defaults seeded; partial upsert; secret round-trip; missing required key reported.

import type { SettingsMap } from '@/lib/types'

/** Read all settings rows as a map (raw values — masking happens at the API layer). */
export function readAllSettings(): SettingsMap {
  throw new Error('Not implemented — see PRD §6.4')
}

/** Upsert only the provided keys. Empty string clears a key. */
export function writeSettings(_partial: SettingsMap): void {
  throw new Error('Not implemented — see PRD §6.4')
}

/** Seed non-secret defaults (SETTINGS_DEFAULTS) if absent. Called from migrate(). */
export function seedSettingsDefaults(): void {
  throw new Error('Not implemented — see PRD §6.4')
}
