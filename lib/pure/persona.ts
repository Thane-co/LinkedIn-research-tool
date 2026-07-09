// Layer 0 — persona derivation (PRD §17.2). Zero I/O.
// A "persona" is the normalized-name key that links a person's accounts across platforms: two
// creator accounts whose display names normalize to the same key are treated as the same person.
// This is the default "auto-match by display name"; the user can override it with an explicit label.

/**
 * Normalize a display name to a stable persona key, or null when there's nothing usable.
 * Steps: take the part before the first comma (drops credentials like ", PhD"), lowercase, strip
 * diacritics, drop any non-alphanumeric character, collapse whitespace, trim.
 */
export function derivePersonaKey(name: string | null | undefined): string | null {
  if (!name) return null
  const key = name
    .split(',')[0]! // drop ", PhD" / ", MBA" style credentials
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // keep only alphanumerics; everything else becomes a space
    .trim()
  return key.length > 0 ? key : null
}
