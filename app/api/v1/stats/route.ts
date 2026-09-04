// Layer 4 — GET /api/v1/stats (PRD §20). What is actually in the corpus: posts per platform and
// market, date coverage, enrichment counts. The orienting call before any search.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { getCorpusStats } from '@/lib/db/posts.repo'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  return NextResponse.json(getCorpusStats())
}
