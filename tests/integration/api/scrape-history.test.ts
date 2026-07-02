// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/scrape/history/route'
import { getDb, resetDb } from '@/lib/db/db'
import { createJob, finishJob } from '@/lib/db/jobs.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('GET /api/scrape/history', () => {
  it('returns recent jobs newest-first with their stats', async () => {
    const a = createJob({ mode: 'both', platforms: ['linkedin'], market: 'ai', params: null })
    finishJob(a.id, {
      status: 'succeeded',
      stats: { keyword_raw: 5, creator_raw: 0, merged_total: 5, duplicates: 0, found_in_both: 0, inserted: 5 },
    })
    createJob({ mode: 'keyword', platforms: ['twitter'], market: 'ai', params: null })

    const res = await GET(new Request('http://localhost/api/scrape/history'))
    expect(res.status).toBe(200)
    const { jobs } = await res.json()
    expect(jobs).toHaveLength(2)
    expect(jobs[0].status).toBe('running') // newest first (the second job)
    expect(jobs[1].inserted).toBe(5)
  })
})
