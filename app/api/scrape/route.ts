// Layer 4 — POST /api/scrape (PRD §10.6, §11.3, §12 step 25). Thin.
// Checks required keys first (Apify token; Voyage for follow-on enrich); 412 with { needs: [...] }
// when missing. Kicks off runScrape WITHOUT awaiting; returns { jobId } immediately.
// TDD: start returns jobId immediately; 412 when required keys missing.

import { NextResponse } from 'next/server'

export async function POST(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §10.6' }, { status: 501 })
}
