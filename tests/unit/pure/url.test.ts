import { describe, expect, it } from 'vitest'
import {
  extractActivityId,
  extractLinkedInSlug,
  extractTwitterHandle,
  normalizeProfileUrl,
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
