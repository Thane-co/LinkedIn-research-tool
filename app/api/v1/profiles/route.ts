// Layer 4 — GET /api/v1/profiles (PRD §20). Profiles scraped so far. `raw_data` is stripped: it is
// the unfiltered actor payload and has no business leaving the tool.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { listProfiles } from '@/lib/db/profiles.repo'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  const profiles = listProfiles().map(({ raw_data: _r, ...rest }) => rest)
  return NextResponse.json({ profiles })
}
