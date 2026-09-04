// Layer 4 — GET /api/v1/keywords (PRD §20). The saved keyword sets, grouped by market.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { listKeywords } from '@/lib/db/keywords.repo'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  return NextResponse.json({ groups: listKeywords() })
}
