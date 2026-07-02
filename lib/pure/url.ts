// Layer 0 — url canonicalization (PRD §8.2, §10.3). Zero I/O.
// Invariant (CLAUDE.md): derive a post's id from the canonical URL's activity URN, not raw.id.

const ACTIVITY_RE = /(?:activity|ugcPost|share)[-:](\d+)/

/**
 * Return `url` only if it is a safe `http(s)` link, else `undefined`. Guards a scraped/injected
 * `javascript:` or `data:` value from becoming a clickable href (React does not block those schemes).
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Extract the numeric activity/ugcPost/share id from a LinkedIn post URL, or null. */
export function extractActivityId(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.match(ACTIVITY_RE)
  return match ? match[1]! : null
}

/** Normalize a LinkedIn profile url: drop query string (e.g. ?miniProfileUrn=...), hash, trailing slash. */
export function normalizeProfileUrl(url: string): string {
  let out = url.split('?')[0]!.split('#')[0]!
  if (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

const LINKEDIN_SLUG_RE = /\/(?:in|company)\/([^/?#]+)/i

/** Extract the profile slug from a LinkedIn /in/<slug> or /company/<slug> url, or null. */
export function extractLinkedInSlug(url: string): string | null {
  const match = url.match(LINKEDIN_SLUG_RE)
  return match ? match[1]! : null
}

/** Extract a clean Twitter/X handle (no @) from a url or @handle input, or null. */
export function extractTwitterHandle(input: string): string | null {
  if (!input) return null
  const trimmed = input.trim()

  if (/^https?:\/\//i.test(trimmed)) {
    const match = trimmed.match(/(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]+)/i)
    if (!match) return null
    return match[1]!.replace(/^@/, '')
  }

  const handle = trimmed.replace(/^@/, '')
  return /^[A-Za-z0-9_]+$/.test(handle) ? handle : null
}
