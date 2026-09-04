// Layer 2 — bearer-token guard for the read-only agent API (PRD §20).
//
// The app itself is unauthenticated on localhost, which is fine for a browser tab you opened. An
// external agent is different: it holds a long-lived credential, so /api/v1 is gated by its own
// token, stored in `settings` under `readonly_api_token` (never in code, never in env).
//
// Fail CLOSED: with no token configured the API is off (503), never open. The token is read from
// headers only — a `?token=` query param would leak into shell history, proxy logs, and referers.

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getKey } from '@/lib/settings'

export const READONLY_TOKEN_KEY = 'readonly_api_token'

/** The token the caller presented: `Authorization: Bearer <t>` or `x-api-key: <t>`. */
function presentedToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  const bearer = auth ? /^bearer\s+(\S.*)$/i.exec(auth.trim()) : null
  if (bearer?.[1]) return bearer[1].trim()
  return req.headers.get('x-api-key')?.trim() || null
}

/** Constant-time compare of equal-length tokens (length mismatch short-circuits to false). */
function tokensMatch(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(configured, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Gate a read-only route. Returns a `NextResponse` to short-circuit the handler, or `null` to
 * proceed. 503 = no token configured (API disabled); 401 = missing/incorrect token.
 */
export function requireReadToken(req: Request): NextResponse | null {
  const configured = getKey(READONLY_TOKEN_KEY)
  if (!configured) {
    return NextResponse.json(
      { error: 'Read-only API is disabled: no token configured. Run `npm run api:token` to create one.' },
      { status: 503 },
    )
  }
  const presented = presentedToken(req)
  if (!presented || !tokensMatch(presented, configured)) {
    return NextResponse.json(
      { error: 'Unauthorized. Send the read-only token as `Authorization: Bearer <token>`.' },
      { status: 401 },
    )
  }
  return null
}
