// Layer 2 — scrape_jobs CRUD (PRD §12 step 15).
// TDD: create/update/get a scrape job.

import type { ScrapeJobRow, ScrapeMode, ScrapeStats } from '@/lib/types'

export function createJob(_job: {
  mode: ScrapeMode
  platforms: string[]
  market: string | null
  params: unknown
}): ScrapeJobRow {
  throw new Error('Not implemented — see PRD §10.6')
}

export function finishJob(
  _id: string,
  _result:
    | { status: 'succeeded'; stats: ScrapeStats }
    | { status: 'failed'; error: string },
): void {
  throw new Error('Not implemented — see PRD §10.6')
}

export function getJob(_id: string): ScrapeJobRow | null {
  throw new Error('Not implemented — see PRD §10.6')
}
