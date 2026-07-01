// Layer 4 — POST /api/scrape (PRD §10.6, §11.3, §12 step 25). Thin.
// Checks required keys first (Apify token; Voyage for follow-on enrich); 412 with { needs: [...] }
// when missing. Creates the job, kicks off runScrape WITHOUT awaiting, returns { jobId } immediately.

import { NextResponse } from 'next/server'
import { runScrape } from '@/jobs/scrape'
import { createJob } from '@/lib/db/jobs.repo'
import { getKey, getSettings } from '@/lib/settings'
import type { Platform, ScrapeMode, Timeframe } from '@/lib/types'

export async function POST(req: Request): Promise<NextResponse> {
  // Required BYO keys: Apify to scrape, Voyage for the follow-on enrich (PRD §11.3).
  const needs: string[] = []
  if (!getKey('apify_api_token')) needs.push('apify_api_token')
  if (!getKey('voyage_api_key')) needs.push('voyage_api_key')
  if (needs.length > 0) return NextResponse.json({ needs }, { status: 412 })

  const body = (await req.json()) as {
    platforms?: Platform[]
    mode?: ScrapeMode
    keywords?: string[]
    creatorIds?: string[]
    timeframe?: Timeframe
    market?: string
  }
  const platforms = body.platforms ?? ['linkedin', 'twitter']
  const mode = body.mode ?? 'both'
  const timeframe = body.timeframe ?? 'week'
  const market = body.market ?? getSettings().default_market ?? 'ai'

  // Create the job up front so we can return its id immediately (PRD §10.6), then run async.
  const job = createJob({
    mode,
    platforms,
    market,
    params: { timeframe, keywords: body.keywords ?? [], creatorIds: body.creatorIds ?? [] },
  })
  void runScrape({
    platforms,
    mode,
    keywords: body.keywords,
    creatorIds: body.creatorIds,
    timeframe,
    market,
    jobId: job.id,
  }).catch((err) => console.error('scrape: runScrape crashed:', (err as Error).message))

  return NextResponse.json({ jobId: job.id }, { status: 202 })
}
