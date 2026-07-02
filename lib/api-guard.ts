// CSRF guard for the local, no-auth server. Because the app runs unauthenticated on localhost, a
// site the user visits could try to drive-by POST/PUT/DELETE to it. Mutating route handlers call
// rejectCrossOrigin(req) first and return its 403 if the request's Origin isn't the local app.

import { NextResponse } from 'next/server'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True when a browser Origin belongs to the local app (any port, http or https). */
function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Reject a state-changing request whose `Origin` header is present and NOT the local app. Requests
 * with no `Origin` (same-origin navigations, server-to-server, tests) pass. Returns a 403
 * `NextResponse` to short-circuit the handler, or `null` to proceed.
 */
export function rejectCrossOrigin(req: Request): NextResponse | null {
  const origin = req.headers.get('origin')
  if (origin === null) return null
  return isLocalOrigin(origin)
    ? null
    : NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 })
}
