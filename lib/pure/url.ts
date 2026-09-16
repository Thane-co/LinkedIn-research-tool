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

const SUBSTACK_SUB_RE = /^([a-z0-9-]+)\.substack\.com$/i
// Substack system subdomains that are not a publication handle.
const SUBSTACK_RESERVED = new Set(['www', 'open'])

/**
 * Extract a clean Substack publication handle from a substack.com url, or null (§17). Handles two
 * forms: `https://<pub>.substack.com/...` → `<pub>`, and `https://substack.com/@<handle>` → `<handle>`.
 * Substack is URL-driven: a bare handle or a custom domain returns null (a bare word stays a Twitter
 * handle; a custom-domain publication must be added by its .substack.com url).
 */
export function extractSubstackHandle(input: string): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!/substack\.com/i.test(trimmed)) return null

  let host: string
  let pathname: string
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    host = u.hostname.toLowerCase()
    pathname = u.pathname
  } catch {
    return null
  }

  if (host === 'substack.com' || host === 'www.substack.com') {
    const m = pathname.match(/^\/@([A-Za-z0-9_-]+)/)
    return m ? m[1]! : null
  }

  const m = host.match(SUBSTACK_SUB_RE)
  if (!m) return null
  const sub = m[1]!.toLowerCase()
  return SUBSTACK_RESERVED.has(sub) ? null : sub
}

// Image CDN hosts a browser tends to refuse to load third-party (tracking-protection, cookie/referer
// quirks) even though they fetch fine server-side. Instagram/FB and LinkedIn media are routed through
// our own origin via /api/media so they display reliably (§18) — LinkedIn posters/covers live on
// `media.licdn.com` and the browser blocks them cross-origin, showing a broken-image icon on the card.
// This list is also the proxy route's SSRF allowlist. `licdn.com` covers media./dms./media-exp*.licdn.com.
const MEDIA_PROXY_HOSTS = ['cdninstagram.com', 'fbcdn.net', 'licdn.com']

/** True only when `url` is an http(s) url whose host is (or is a subdomain of) an allowed media CDN.
 *  Dot-bounded suffix match so `notcdninstagram.com` and a `cdninstagram.com` path don't slip through. */
export function isProxyableMediaUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return MEDIA_PROXY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/** The `src` to render for a media url: proxied through /api/media for Instagram/FB CDN hosts, passed
 *  through unchanged for everything else. Returns `undefined` for a missing url or a dangerous absolute
 *  scheme (javascript:/data:) — a relative/opaque string passes through (it can't execute). */
export function mediaProxySrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    const { protocol } = new URL(url) // absolute url — enforce a safe scheme
    if (protocol !== 'http:' && protocol !== 'https:') return undefined
    return isProxyableMediaUrl(url) ? `/api/media?url=${encodeURIComponent(url)}` : url
  } catch {
    return url // not an absolute url (relative/opaque) — no host to proxy, safe to pass through
  }
}

// A signed media url is only good until its expiry; after that the CDN answers 403 forever. Bounds
// keep a false positive impossible-ish: a stray `e=` that is not a timestamp must NOT hide a live
// image, so anything outside [2001, 2100] is read as "carries no expiry".
const MIN_PLAUSIBLE_EXPIRY_S = 1_000_000_000 // 2001-09-09
const MAX_PLAUSIBLE_EXPIRY_S = 4_102_444_800 // 2100-01-01

/**
 * The expiry baked into a signed CDN media url, as epoch **milliseconds**, or null when it has none.
 *
 * Two conventions, both confirmed against this corpus:
 *   • LinkedIn `media.licdn.com` — `e=<seconds>` in **decimal**
 *   • Instagram/Facebook `*.cdninstagram.com` — `oe=<seconds>` in **hex**
 */
export function mediaUrlExpiry(url: string | null | undefined): number | null {
  if (!url) return null
  const hex = /[?&]oe=([0-9A-Fa-f]+)(?:&|$)/.exec(url)
  const dec = /[?&]e=(\d+)(?:&|$)/.exec(url)
  const seconds = hex ? parseInt(hex[1]!, 16) : dec ? Number(dec[1]) : NaN
  if (!Number.isFinite(seconds)) return null
  if (seconds < MIN_PLAUSIBLE_EXPIRY_S || seconds > MAX_PLAUSIBLE_EXPIRY_S) return null
  return seconds * 1000
}

/**
 * True when this media url is provably dead: it is signed and its expiry has passed.
 *
 * Lets the card skip rendering an image it KNOWS will 403, without a network round trip. Unsigned
 * urls and local paths report false — there is nothing to go on, so they are attempted and any
 * failure is caught by the img's own onError.
 */
export function isExpiredMediaUrl(url: string | null | undefined, now: number = Date.now()): boolean {
  const expiry = mediaUrlExpiry(url)
  return expiry !== null && expiry <= now
}

// Instagram path segments that are features, not a profile handle.
const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 's', 'accounts'])

/**
 * Extract a clean Instagram username (no @, lowercased) from an instagram.com url, or null (§18).
 * Instagram is URL-driven like Substack: a bare word stays a Twitter handle, so only an
 * `instagram.com/<user>` url resolves. A post/reel url (`/p/…`, `/reel/…`) carries no handle → null.
 */
export function extractInstagramHandle(input: string): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!/instagram\.com/i.test(trimmed)) return null

  let pathname: string
  try {
    pathname = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).pathname
  } catch {
    return null
  }

  const m = pathname.match(/^\/@?([A-Za-z0-9._]+)/)
  if (!m) return null
  const handle = m[1]!.toLowerCase()
  return INSTAGRAM_RESERVED.has(handle) ? null : handle
}

const INSTAGRAM_SHORTCODE_RE = /instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i

/** Extract the shortcode from an Instagram post/reel/tv url (§18), or null (e.g. a profile url).
 *  Used to match transcript results (keyed by shortCode) back to the post they belong to. */
export function extractInstagramShortcode(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(INSTAGRAM_SHORTCODE_RE)
  return m ? m[1]! : null
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
