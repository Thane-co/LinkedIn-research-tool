// Layer 4 — GET /api/media (§18): a same-origin image proxy for Instagram/FB + LinkedIn CDN
// posters/photos. Those images fetch fine server-side but a browser often refuses to load them
// third-party (tracking-protection, cookie/referer quirks), so the card requests them from our own
// origin instead. SSRF guard: only hosts on the isProxyableMediaUrl allowlist are ever fetched.

import { NextResponse } from 'next/server'
import { fetchWithTimeout } from '@/lib/http'
import { isProxyableMediaUrl } from '@/lib/pure/url'

// Fetches an external image on each call — never prerender/cache at build time.
export const dynamic = 'force-dynamic'

const FETCH_TIMEOUT_MS = 20_000
// Present a browser UA + the CDN's own site as referer, matching what loads reliably from each CDN.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** The referer to present upstream, matched to the CDN host (LinkedIn media 403s a foreign referer). */
function refererFor(url: string): string {
  return /(^|\.)licdn\.com$/i.test(new URL(url).hostname) ? 'https://www.linkedin.com/' : 'https://www.instagram.com/'
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url).searchParams.get('url')
  // SSRF guard: only proxy http(s) urls on the Instagram/FB/LinkedIn CDN allowlist.
  if (!url || !isProxyableMediaUrl(url)) {
    return NextResponse.json({ error: 'unsupported media url' }, { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetchWithTimeout(
      url,
      { headers: { 'user-agent': UA, referer: refererFor(url) } },
      FETCH_TIMEOUT_MS,
    )
  } catch {
    return NextResponse.json({ error: 'media fetch failed' }, { status: 502 })
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 })
  }

  const contentType = upstream.headers.get('content-type') ?? 'image/jpeg'
  const body = await upstream.arrayBuffer()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=86400' },
  })
}
