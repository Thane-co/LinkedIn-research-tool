// Layer 6 — GET /api/scrape/history (PRD §11.6). The last 20 scrape_jobs runs for the history
// table. Static `history` segment takes precedence over the sibling `[id]` dynamic route.

import { NextResponse } from 'next/server'
import { listRecentJobs } from '@/lib/db/jobs.repo'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ jobs: listRecentJobs(20) })
}
