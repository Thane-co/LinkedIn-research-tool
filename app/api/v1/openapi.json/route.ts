// Layer 4 — GET /api/v1/openapi.json (PRD §20). The manifest as an OpenAPI 3.1 document.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { buildOpenApiSpec } from '@/lib/openapi'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  return NextResponse.json(buildOpenApiSpec(new URL(req.url).origin))
}
