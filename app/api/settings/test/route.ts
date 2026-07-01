// Layer 4 — POST /api/settings/test (PRD §11.4, optional). Cheap live per-provider check
// (Apify GET /v2/users/me; Voyage 1-token embed; Anthropic 1-token message) -> { ok, error? }.

import { NextResponse } from 'next/server'

export async function POST(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.4' }, { status: 501 })
}
