import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { createJob, finishJob, getJob, listRecentJobs } from '@/lib/db/jobs.repo'
import type { ScrapeStats } from '@/lib/types'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const stats: ScrapeStats = {
  keyword_raw: 10,
  creator_raw: 5,
  merged_total: 13,
  duplicates: 2,
  found_in_both: 1,
  inserted: 11,
}

describe('jobs.repo', () => {
  it('creates a running job with a generated id and serialized fields', () => {
    const job = createJob({
      mode: 'both',
      platforms: ['linkedin', 'twitter'],
      market: 'ai',
      params: { keywords: ['ai'] },
    })
    expect(job.id).toBeTruthy()
    expect(job.status).toBe('running')
    expect(job.started_at).toBeTruthy()
    expect(job.finished_at).toBeNull()
    expect(JSON.parse(job.platforms)).toEqual(['linkedin', 'twitter'])
    expect(JSON.parse(job.params!)).toEqual({ keywords: ['ai'] })
  })

  it('getJob round-trips a created job and returns null for a missing id', () => {
    const job = createJob({ mode: 'keyword', platforms: ['linkedin'], market: null, params: null })
    expect(getJob(job.id)?.id).toBe(job.id)
    expect(getJob('nope')).toBeNull()
  })

  it('finishJob(succeeded) records the stats and finished_at', () => {
    const job = createJob({ mode: 'keyword', platforms: ['linkedin'], market: 'ai', params: null })
    finishJob(job.id, { status: 'succeeded', stats })
    const done = getJob(job.id)!
    expect(done.status).toBe('succeeded')
    expect(done.finished_at).toBeTruthy()
    expect(done.inserted).toBe(11)
    expect(done.duplicates).toBe(2)
    expect(done.found_in_both).toBe(1)
    expect(done.error).toBeNull()
  })

  it('finishJob(failed) records the error and finished_at', () => {
    const job = createJob({ mode: 'keyword', platforms: ['linkedin'], market: 'ai', params: null })
    finishJob(job.id, { status: 'failed', error: 'apify exploded' })
    const done = getJob(job.id)!
    expect(done.status).toBe('failed')
    expect(done.error).toBe('apify exploded')
    expect(done.finished_at).toBeTruthy()
  })

  it('listRecentJobs returns newest-first, capped at the limit', () => {
    for (let i = 0; i < 5; i++) {
      createJob({ mode: 'keyword', platforms: ['linkedin'], market: 'ai', params: null })
    }
    const recent = listRecentJobs(3)
    expect(recent).toHaveLength(3)
    // started_at is descending (newest first)
    const times = recent.map((j) => j.started_at)
    expect([...times].sort((a, b) => (a < b ? 1 : -1))).toEqual(times)
  })
})
