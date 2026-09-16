import { describe, expect, it } from 'vitest'
import {
  extractActivityId,
  extractInstagramHandle,
  extractInstagramShortcode,
  extractLinkedInSlug,
  extractSubstackHandle,
  extractTwitterHandle,
  isProxyableMediaUrl,
  mediaProxySrc,
  normalizeProfileUrl,
  isExpiredMediaUrl,
  mediaUrlExpiry,
  safeHref,
} from '@/lib/pure/url'

describe('safeHref', () => {
  it('passes http and https urls through unchanged', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x')
    expect(safeHref('http://example.com')).toBe('http://example.com')
  })

  it('rejects javascript:/data:/other non-http(s) schemes (→ undefined)', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>1</script>')).toBeUndefined()
    expect(safeHref('file:///etc/passwd')).toBeUndefined()
  })

  it('rejects null / undefined / unparseable input', () => {
    expect(safeHref(null)).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
    expect(safeHref('not a url')).toBeUndefined()
  })
})

describe('extractActivityId', () => {
  it('extracts the id from an activity URN url', () => {
    expect(
      extractActivityId('https://www.linkedin.com/feed/update/urn:li:activity:7123456789/'),
    ).toBe('7123456789')
  })

  it('extracts from the /posts/..._activity-<id>-<slug> form (hyphen separator)', () => {
    expect(
      extractActivityId('https://www.linkedin.com/posts/jane_ai-tips-activity-7999-abcd'),
    ).toBe('7999')
  })

  it('extracts from a ugcPost URN', () => {
    expect(extractActivityId('urn:li:ugcPost:7001')).toBe('7001')
  })

  it('extracts from a share URN', () => {
    expect(extractActivityId('urn:li:share:7002')).toBe('7002')
  })

  it('returns null for a url with no recognizable urn', () => {
    expect(extractActivityId('https://www.linkedin.com/in/someone')).toBeNull()
  })

  it('returns null for null / undefined / empty input', () => {
    expect(extractActivityId(null)).toBeNull()
    expect(extractActivityId(undefined)).toBeNull()
    expect(extractActivityId('')).toBeNull()
  })
})

describe('normalizeProfileUrl', () => {
  it('strips the ?miniProfileUrn query string (the equality-breaking bug)', () => {
    expect(
      normalizeProfileUrl('https://www.linkedin.com/in/jane?miniProfileUrn=urn%3Ali%3Afs_x'),
    ).toBe('https://www.linkedin.com/in/jane')
  })

  it('strips a trailing slash and hash fragment', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/jane/#about')).toBe(
      'https://www.linkedin.com/in/jane',
    )
  })

  it('leaves an already-clean url unchanged', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/jane')).toBe(
      'https://www.linkedin.com/in/jane',
    )
  })
})

describe('extractLinkedInSlug', () => {
  it('extracts the slug from an /in/ profile url', () => {
    expect(extractLinkedInSlug('https://www.linkedin.com/in/jane-doe')).toBe('jane-doe')
  })

  it('extracts the slug from a /company/ url', () => {
    expect(extractLinkedInSlug('https://www.linkedin.com/company/acme-inc')).toBe('acme-inc')
  })

  it('ignores a trailing slash / query string (already normalized upstream, but be safe)', () => {
    expect(extractLinkedInSlug('https://www.linkedin.com/in/jane/?x=1')).toBe('jane')
  })

  it('returns null when there is no /in/ or /company/ segment', () => {
    expect(extractLinkedInSlug('https://www.linkedin.com/feed/')).toBeNull()
    expect(extractLinkedInSlug('')).toBeNull()
  })
})

describe('extractTwitterHandle', () => {
  it('strips a leading @', () => {
    expect(extractTwitterHandle('@jane')).toBe('jane')
  })

  it('extracts the handle from an x.com url', () => {
    expect(extractTwitterHandle('https://x.com/jane')).toBe('jane')
  })

  it('extracts the handle from a twitter.com status url', () => {
    expect(extractTwitterHandle('https://twitter.com/jane/status/123')).toBe('jane')
  })

  it('returns a bare handle unchanged', () => {
    expect(extractTwitterHandle('jane')).toBe('jane')
  })

  it('returns null for empty / non-handle input', () => {
    expect(extractTwitterHandle('')).toBeNull()
    expect(extractTwitterHandle('https://x.com/')).toBeNull()
  })

  it('returns null for a bare string containing invalid handle characters', () => {
    expect(extractTwitterHandle('not a handle!')).toBeNull()
  })
})

describe('extractSubstackHandle', () => {
  it('extracts the subdomain from a <pub>.substack.com url', () => {
    expect(extractSubstackHandle('https://noahpinion.substack.com')).toBe('noahpinion')
  })

  it('extracts the subdomain ignoring the post path', () => {
    expect(extractSubstackHandle('https://laraacosta.substack.com/p/the-full-breakdown')).toBe('laraacosta')
  })

  it('extracts the handle from a substack.com/@handle url', () => {
    expect(extractSubstackHandle('https://substack.com/@laraacostar')).toBe('laraacostar')
    expect(extractSubstackHandle('https://www.substack.com/@lara')).toBe('lara')
  })

  it('tolerates a missing scheme and a trailing slash', () => {
    expect(extractSubstackHandle('noahpinion.substack.com/')).toBe('noahpinion')
  })

  it('ignores the www / open system subdomains', () => {
    expect(extractSubstackHandle('https://www.substack.com')).toBeNull()
    expect(extractSubstackHandle('https://open.substack.com/pub/x')).toBeNull()
  })

  it('returns null for non-substack urls and bare handles (Substack is URL-driven)', () => {
    expect(extractSubstackHandle('https://x.com/lara')).toBeNull()
    expect(extractSubstackHandle('noahpinion')).toBeNull()
    expect(extractSubstackHandle('')).toBeNull()
  })
})

describe('extractInstagramHandle', () => {
  it('extracts the username from an instagram.com profile url', () => {
    expect(extractInstagramHandle('https://www.instagram.com/natgeo/')).toBe('natgeo')
    expect(extractInstagramHandle('https://instagram.com/natgeo')).toBe('natgeo')
  })

  it('lowercases and keeps dots/underscores (valid IG username chars)', () => {
    expect(extractInstagramHandle('https://www.instagram.com/Lara.Acosta_r/')).toBe('lara.acosta_r')
  })

  it('tolerates a missing scheme and a leading @', () => {
    expect(extractInstagramHandle('instagram.com/@natgeo')).toBe('natgeo')
  })

  it('returns null for a post/reel url (no profile handle there)', () => {
    expect(extractInstagramHandle('https://www.instagram.com/p/DLNsnpUTdVS/')).toBeNull()
    expect(extractInstagramHandle('https://www.instagram.com/reel/DLNsnpUTdVS/')).toBeNull()
    expect(extractInstagramHandle('https://www.instagram.com/explore/')).toBeNull()
  })

  it('returns null for non-instagram urls and bare handles (IG is URL-driven)', () => {
    expect(extractInstagramHandle('https://x.com/natgeo')).toBeNull()
    expect(extractInstagramHandle('natgeo')).toBeNull()
    expect(extractInstagramHandle('')).toBeNull()
  })
})

describe('extractInstagramShortcode', () => {
  it('extracts the shortcode from /p/, /reel/, /tv/ urls', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/p/DLNsnpUTdVS/')).toBe('DLNsnpUTdVS')
    expect(extractInstagramShortcode('https://www.instagram.com/reel/DV29mBcMQwp/')).toBe('DV29mBcMQwp')
    expect(extractInstagramShortcode('https://www.instagram.com/tv/ABC123/')).toBe('ABC123')
  })

  it('returns null for a profile url or a non-instagram url', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/natgeo/')).toBeNull()
    expect(extractInstagramShortcode('https://x.com/p/abc')).toBeNull()
    expect(extractInstagramShortcode(null)).toBeNull()
  })
})

describe('isProxyableMediaUrl', () => {
  it('is true for Instagram/Facebook/LinkedIn CDN hosts (incl. subdomains)', () => {
    expect(isProxyableMediaUrl('https://scontent-lga3-1.cdninstagram.com/v/x.jpg')).toBe(true)
    expect(isProxyableMediaUrl('https://cdninstagram.com/x.jpg')).toBe(true)
    expect(isProxyableMediaUrl('https://scontent.xx.fbcdn.net/v/x.jpg')).toBe(true)
    expect(isProxyableMediaUrl('https://media.licdn.com/dms/image/x.jpg')).toBe(true)
    expect(isProxyableMediaUrl('https://dms.licdn.com/playlist/x')).toBe(true)
  })

  it('is false for other hosts and non-http(s) schemes (SSRF guard)', () => {
    expect(isProxyableMediaUrl('https://evil.com/cdninstagram.com')).toBe(false) // path, not host
    expect(isProxyableMediaUrl('https://notcdninstagram.com/x.jpg')).toBe(false) // suffix must be dot-bounded
    expect(isProxyableMediaUrl('https://notlicdn.com/x.jpg')).toBe(false) // suffix must be dot-bounded
    expect(isProxyableMediaUrl('file:///etc/passwd')).toBe(false)
    expect(isProxyableMediaUrl('not a url')).toBe(false)
  })
})

describe('mediaProxySrc', () => {
  it('routes an Instagram CDN url through the same-origin proxy (encoded)', () => {
    const src = mediaProxySrc('https://scontent-lga3-1.cdninstagram.com/v/x.jpg?a=1&b=2')
    expect(src).toBe(`/api/media?url=${encodeURIComponent('https://scontent-lga3-1.cdninstagram.com/v/x.jpg?a=1&b=2')}`)
  })

  it('routes a LinkedIn CDN poster through the same-origin proxy (browser blocks it direct)', () => {
    const url = 'https://media.licdn.com/dms/image/v2/x/videocover-high/0/1?e=1&v=beta&t=z'
    expect(mediaProxySrc(url)).toBe(`/api/media?url=${encodeURIComponent(url)}`)
  })

  it('returns undefined for a missing or unsafe url (never emits an unsafe src)', () => {
    expect(mediaProxySrc(null)).toBeUndefined()
    expect(mediaProxySrc(undefined)).toBeUndefined()
    expect(mediaProxySrc('javascript:alert(1)')).toBeUndefined()
  })
})

// Signed CDN media urls carry their own expiry. Once it passes the CDN answers 403 forever, so the
// card can tell the image is dead WITHOUT a request — 37k+ posts in the corpus are in that state,
// and each would otherwise fire a doomed fetch through /api/media just to render a broken icon.
describe('mediaUrlExpiry / isExpiredMediaUrl', () => {
  const AT = Date.UTC(2026, 8, 8) // 2026-09-08, the "now" these tests reason about
  const secs = (ms: number): number => Math.floor(ms / 1000)

  it('reads LinkedIn\'s decimal `e=` seconds', () => {
    const past = secs(AT) - 86_400
    expect(mediaUrlExpiry(`https://media.licdn.com/dms/image/v2/x/feedshare/0/1?e=${past}&v=beta&t=z`)).toBe(
      past * 1000,
    )
  })

  it('reads the Instagram/Facebook CDN\'s HEX `oe=` seconds', () => {
    // oe=6A60A606 is 2026-07-22 — the convention really is base 16, not base 10.
    expect(mediaUrlExpiry('https://scontent.cdninstagram.com/v/t51/1.jpg?stp=x&oe=6A60A606')).toBe(
      0x6a60a606 * 1000,
    )
  })

  it('returns null when the url carries no expiry at all (Substack, local paths)', () => {
    expect(mediaUrlExpiry('https://substackcdn.com/image/fetch/a.jpg')).toBeNull()
    expect(mediaUrlExpiry('/post-images/posts/123.jpg')).toBeNull()
  })

  it('ignores an implausible timestamp rather than hiding a live image', () => {
    // A false positive HIDES a working image, so anything outside a sane date range is "no expiry".
    expect(mediaUrlExpiry('https://media.licdn.com/x?e=1')).toBeNull() // 1970
    expect(mediaUrlExpiry('https://media.licdn.com/x?e=99999999999')).toBeNull() // year 5138
    expect(mediaUrlExpiry('https://media.licdn.com/x?e=notanumber')).toBeNull()
  })

  it('flags a url whose expiry has passed, and spares one that has not', () => {
    const past = secs(AT) - 86_400
    const future = secs(AT) + 86_400
    expect(isExpiredMediaUrl(`https://media.licdn.com/x?e=${past}&v=beta&t=z`, AT)).toBe(true)
    expect(isExpiredMediaUrl(`https://media.licdn.com/x?e=${future}&v=beta&t=z`, AT)).toBe(false)
  })

  it('treats an unsigned or missing url as not-expired (nothing to go on)', () => {
    expect(isExpiredMediaUrl(null, AT)).toBe(false)
    expect(isExpiredMediaUrl(undefined, AT)).toBe(false)
    expect(isExpiredMediaUrl('/post-images/posts/123.jpg', AT)).toBe(false)
    expect(isExpiredMediaUrl('https://substackcdn.com/a.jpg', AT)).toBe(false)
  })
})
