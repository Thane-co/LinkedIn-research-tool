// Layer 2 — OPTIONAL Claude-vision image description (PRD §7.4, §12 step 19).
// Reads anthropic_api_key from settings (BYO). Optional: degrades gracefully when key unset.
// TDD: mocked HTTP; returns a short description; no-key path handled by caller (enrich).

/** 1-2 sentence factual description of the image at url, or null when disabled/unavailable. */
export function describeImage(_url: string): Promise<string | null> {
  throw new Error('Not implemented — see PRD §7.4')
}
