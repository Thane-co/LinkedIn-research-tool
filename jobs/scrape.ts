// Layer 3 — runScrape orchestration + recomputeXFactors (PRD §10.5, §8.4, §12 step 21).
// TDD: both scrapers run in parallel; stats incl. duplicate/both counts; one scraper empty still
// completes; both fail -> job 'failed'; x-factor recompute scoped to affected authors; recompute
// matches on author_id NOT author_url.

import type { ScrapeStats, Timeframe } from '@/lib/types'

export interface RunScrapeOptions {
  platforms: ('linkedin' | 'twitter')[]
  mode: 'keyword' | 'creator' | 'both'
  keywords?: string[]
  creatorIds?: string[]
  timeframe: Timeframe
  market: string
}

/**
 * Full scrape pipeline (PRD §10.5): create job -> run needed actors in parallel (per-run catch) ->
 * map -> merge/dedup -> insert -> fire-and-forget enrich + recomputeXFactors -> finalize job.
 */
export function runScrape(_opts: RunScrapeOptions): Promise<ScrapeStats> {
  throw new Error('Not implemented — see PRD §10.5')
}

/**
 * Recompute weighted_score / creator_baseline / x_factor for the given authors only (PRD §8.4).
 * Match strictly on author_id (clean slug/handle), never on author_url. Non-fatal.
 */
export function recomputeXFactors(_authorIds: string[]): void {
  throw new Error('Not implemented — see PRD §8.4')
}
