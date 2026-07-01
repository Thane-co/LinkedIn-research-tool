// Layer 4 — GET /api/scrape/[id] (PRD §10.6, §12 step 25). Returns the live scrape_jobs row
// so the UI can poll a progress pill. Thin.

import { NextResponse } from 'next/server'
import { getJob } from '@/lib/db/jobs.repo'

export async function GET(
  _req: Request,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const job = getJob(ctx.params.id)
  if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 })
  return NextResponse.json(job)
}
