// Layer 2 — scrape_jobs CRUD (PRD §12 step 15).

import { getDb } from '@/lib/db/db'
import type { ScrapeJobRow, ScrapeMode, ScrapeStats } from '@/lib/types'

const COLUMNS = `id, status, mode, platforms, market, params, keyword_raw, creator_raw, merged_total, duplicates, found_in_both, inserted, error, started_at, finished_at`

export function createJob(job: {
  mode: ScrapeMode
  platforms: string[]
  market: string | null
  params: unknown
}): ScrapeJobRow {
  const row: ScrapeJobRow = {
    id: crypto.randomUUID(),
    status: 'running',
    mode: job.mode,
    platforms: JSON.stringify(job.platforms),
    market: job.market,
    params: job.params === null || job.params === undefined ? null : JSON.stringify(job.params),
    keyword_raw: 0,
    creator_raw: 0,
    merged_total: 0,
    duplicates: 0,
    found_in_both: 0,
    inserted: 0,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  }
  getDb()
    .prepare(
      `INSERT INTO scrape_jobs (${COLUMNS}) VALUES
       (@id, @status, @mode, @platforms, @market, @params, @keyword_raw, @creator_raw, @merged_total, @duplicates, @found_in_both, @inserted, @error, @started_at, @finished_at)`,
    )
    .run(row)
  return row
}

export function finishJob(
  id: string,
  result:
    | { status: 'succeeded'; stats: ScrapeStats }
    | { status: 'failed'; error: string },
): void {
  const finishedAt = new Date().toISOString()
  if (result.status === 'succeeded') {
    const s = result.stats
    getDb()
      .prepare(
        `UPDATE scrape_jobs SET status = 'succeeded', finished_at = ?,
           keyword_raw = ?, creator_raw = ?, merged_total = ?, duplicates = ?, found_in_both = ?, inserted = ?
         WHERE id = ?`,
      )
      .run(finishedAt, s.keyword_raw, s.creator_raw, s.merged_total, s.duplicates, s.found_in_both, s.inserted, id)
  } else {
    getDb()
      .prepare("UPDATE scrape_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(result.error, finishedAt, id)
  }
}

export function getJob(id: string): ScrapeJobRow | null {
  return (
    (getDb().prepare(`SELECT ${COLUMNS} FROM scrape_jobs WHERE id = ?`).get(id) as
      | ScrapeJobRow
      | undefined) ?? null
  )
}

/** Most-recent scrape runs, newest-first (Layer 6 — scrape history, §11.6). */
export function listRecentJobs(limit = 20): ScrapeJobRow[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM scrape_jobs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as ScrapeJobRow[]
}
