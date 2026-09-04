// Layer 4 — GET /api/v1 (PRD §20): the read-only API's manifest. Only a GET handler is exported, so
// any other verb is a 405 from the framework — the API is read-only by construction, not by policy.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { buildManifest } from '@/lib/openapi'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  return NextResponse.json(buildManifest())
}
