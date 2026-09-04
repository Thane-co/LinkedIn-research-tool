// Read-only server mode (PRD §20.4) — the hard guarantee behind "this agent cannot scrape".
//
// /api/v1 is read-only by construction, but the app's OWN routes (POST /api/scrape, /api/transcribe,
// the ig-compare actors, settings) are unauthenticated on localhost: anything that can reach the
// port can call them and spend Apify credits. Handing an agent a base url is not a control.
//
// So run a SECOND instance for the agent with READONLY_SERVER=1 (npm run start:agent). Every
// side-effecting route in this app is POST/PUT/DELETE — every GET route only reads — so refusing
// non-GET here blocks scraping, transcription, settings writes, and every actor run outright,
// whatever url the agent tries. The normal instance (env unset) is completely unaffected.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The only surface the agent instance serves: the token-gated read-only API. */
function isReadOnlyApi(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/')
}

export function middleware(req: NextRequest): NextResponse {
  // Read the env per request (not at module scope) so the flag is a runtime switch, not baked in.
  if (process.env.READONLY_SERVER !== '1') return NextResponse.next()

  if (!READ_METHODS.has(req.method)) {
    return NextResponse.json(
      {
        error:
          'This server runs in read-only mode: only GET requests are served. Scraping, transcription, and settings changes are disabled here.',
      },
      { status: 403 },
    )
  }
  // Deny by default. The app's OWN GET routes (/api/posts, /api/creators, /api/settings, …) are
  // unauthenticated, so leaving them reachable here would mean the bearer token gated nothing and
  // `api:token --revoke` revoked nothing: a holder could just read /api/posts instead. Allowlisting
  // /api/v1 makes the token the single door on this instance. Deny-by-default also means a path
  // normalization trick can only ever fail closed. The dashboard UI is intentionally not served.
  if (!isReadOnlyApi(req.nextUrl.pathname)) {
    return NextResponse.json(
      { error: 'This server only serves the read-only API at /api/v1. Use the main instance for the app.' },
      { status: 403 },
    )
  }
  return NextResponse.next()
}

// Everything except Next's own static assets — a request that never reaches a handler can't spend.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
