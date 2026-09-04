// Layer 4 — /api/profile (PRD §19). Thin. POST scrapes ONE LinkedIn profile (full details + follower
// count) synchronously and returns it; GET lists the stored profiles. Checks the Apify token first
// (412 { needs } — same gate shape as /api/scrape). Actor/network failure → 502.

import { NextResponse } from 'next/server'
import { scrapeProfile } from '@/jobs/scrape-profile'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { listProfiles } from '@/lib/db/profiles.repo'
import { getKey } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/** The profiles scraped so far, newest first — powers the panel's history list. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ profiles: listProfiles() })
}

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  // Only the Apify token is required (no Voyage — a profile isn't embedded).
  if (!getKey('apify_api_token')) return NextResponse.json({ needs: ['apify_api_token'] }, { status: 412 })

  const body = (await req.json()) as { query?: string }
  const query = body.query?.trim()
  if (!query) return NextResponse.json({ error: 'A profile url or public identifier is required' }, { status: 400 })

  try {
    const profile = await scrapeProfile(query)
    return NextResponse.json({ profile })
  } catch (err) {
    // Actor failure / no profile found — surface as a bad-gateway (upstream) error, not a crash.
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
