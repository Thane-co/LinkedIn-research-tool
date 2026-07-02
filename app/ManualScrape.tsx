'use client'
// Layer 5 — ManualScrape (PRD §11.5 Screen B, §11.3): the manual "Run scrape now" control. There is
// NO scheduler (local, no-cron); this is the only way a scrape starts. POST /api/scrape -> poll
// /api/scrape/[id] -> status pill. Keywords come from the Layer 6 keywords store (passed in for now).

import { useState } from 'react'
import type { ScrapeMode, Timeframe } from '@/lib/types'

type Source = 'both' | 'creator' | 'keyword'
type Pill =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded'; inserted: number }
  | { status: 'failed'; error?: string }
  | { status: 'blocked'; needs: string[] }

const TIMEFRAMES: Timeframe[] = ['24h', '3d', 'week', 'month', '3months']

export function ManualScrape({
  coreCount = 0,
  keywords = [],
  pollIntervalMs = 1500,
}: {
  coreCount?: number
  keywords?: string[]
  pollIntervalMs?: number
}) {
  const [source, setSource] = useState<Source>('both')
  const [platform, setPlatform] = useState<'all' | 'linkedin' | 'twitter'>('all')
  const [timeframe, setTimeframe] = useState<Timeframe>('week')
  const [pill, setPill] = useState<Pill>({ status: 'idle' })

  async function poll(jobId: string): Promise<void> {
    const res = await fetch(`/api/scrape/${jobId}`)
    const job = (await res.json()) as { status: string; inserted?: number; error?: string }
    if (job.status === 'running') {
      setPill({ status: 'running' })
      setTimeout(() => void poll(jobId), pollIntervalMs)
    } else if (job.status === 'succeeded') {
      setPill({ status: 'succeeded', inserted: job.inserted ?? 0 })
    } else {
      setPill({ status: 'failed', error: job.error })
    }
  }

  async function run(): Promise<void> {
    setPill({ status: 'running' })
    const platforms = platform === 'all' ? ['linkedin', 'twitter'] : [platform]
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: source as ScrapeMode, platforms, timeframe, keywords }),
    })
    if (res.status === 412) {
      const { needs } = (await res.json()) as { needs: string[] }
      setPill({ status: 'blocked', needs })
      return
    }
    const { jobId } = (await res.json()) as { jobId: string }
    await poll(jobId)
  }

  return (
    <section className="manual-scrape">
      <h3>Manual Scrape</h3>
      <div className="manual-scrape__controls">
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
            <option value="both">Creators + Keywords</option>
            <option value="creator">Creators</option>
            <option value="keyword">Keywords</option>
          </select>
        </label>
        <label>
          Platform
          <select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
            <option value="all">All platforms</option>
            <option value="linkedin">LinkedIn</option>
            <option value="twitter">Twitter</option>
          </select>
        </label>
        <label>
          Time frame
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button type="button" onClick={run} disabled={pill.status === 'running'}>
        Run scrape now
      </button>
      <span className="manual-scrape__summary">
        {coreCount} core creators + {keywords.length} keywords · {timeframe}
      </span>

      <span className="manual-scrape__pill" data-status={pill.status} role="status">
        {pill.status === 'running' && 'Scraping…'}
        {pill.status === 'succeeded' && `Scrape complete · ${pill.inserted} new`}
        {pill.status === 'failed' && 'Scrape failed'}
        {pill.status === 'blocked' && `Add ${pill.needs.join(', ')} in Settings`}
      </span>
    </section>
  )
}
