// Layer 4 — GET /api/scrape/status (PRD §11.8). Thin.
// Per-platform readiness for the scrape cards: when data last landed, and how many creators are in
// the scrape set. Static `status` segment takes precedence over the sibling `[id]` dynamic route.

import { NextResponse } from 'next/server'
import { listCreators } from '@/lib/db/creators.repo'
import { getLastScrapeByPlatform } from '@/lib/db/posts.repo'
import { countByPlatform } from '@/lib/pure/creator-table'
import { TABLE_PLATFORMS } from '@/lib/pure/creator-table'
import type { Platform } from '@/lib/types'

// Reads the live DB — never statically prerender/cache (PRD §11/§14).
export const dynamic = 'force-dynamic'

export async function GET(_req: Request): Promise<NextResponse> {
  const lastScraped = getLastScrapeByPlatform()
  const creatorCounts = countByPlatform(listCreators().creators)

  const platforms = {} as Record<Platform, { lastScrapedAt: string | null; creators: number }>
  for (const platform of TABLE_PLATFORMS) {
    platforms[platform] = { lastScrapedAt: lastScraped[platform], creators: creatorCounts[platform] }
  }
  return NextResponse.json({ platforms })
}
