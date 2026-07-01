// Layer 4 — GET /api/scrape/[id] (PRD §10.6, §12 step 25). Returns the live scrape_jobs row
// so the UI can poll a progress pill. Thin.

import { NextResponse } from 'next/server'

export async function GET(
  _req: Request,
  _ctx: { params: { id: string } },
): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §10.6' }, { status: 501 })
}
