'use client'
// Layer 5/6 — ManualScrape (PRD §11.5 Screen B, §11.3/§11.6): the manual "Run scrape now" control.
// There is NO scheduler (local, no-cron); this is the only way a scrape starts. Self-contained: pulls
// the core-creator count and the per-market keyword sets, POSTs /api/scrape → polls the status pill.

import { useEffect, useState } from 'react'
import type { ScrapeMode, Timeframe } from '@/lib/types'
import { ApiError, apiFetch } from '@/lib/api-client'

type Source = 'both' | 'creator' | 'keyword'
type Pill =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded'; inserted: number }
  | { status: 'failed'; error?: string }
  | { status: 'blocked'; needs: string[] }

interface KeywordGroup {
  market: string
  terms: { term: string }[]
}

const TIMEFRAMES: Timeframe[] = ['24h', '3d', 'week', 'month', '3months', 'all']
const TIMEFRAME_LABELS: Partial<Record<Timeframe, string>> = { all: 'All time (full history)' }

export function ManualScrape({ pollIntervalMs = 1500 }: { pollIntervalMs?: number }) {
  const [creators, setCreators] = useState<{ platform: string }[]>([])
  const [groups, setGroups] = useState<KeywordGroup[]>([])
  const [source, setSource] = useState<Source>('both')
  const [platform, setPlatform] = useState<'all' | 'linkedin' | 'twitter' | 'substack'>('all')
  const [timeframe, setTimeframe] = useState<Timeframe>('week')
  const [market, setMarket] = useState('') // '' = all markets
  const [includeNotes, setIncludeNotes] = useState(false) // Substack Notes are opt-in (slower)
  const [pill, setPill] = useState<Pill>({ status: 'idle' })
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const onFail = (e: unknown): void => setLoadError(e instanceof Error ? e.message : 'Failed to load')
    apiFetch<{ creators: { platform: string }[] }>('/api/creators')
      .then((b) => setCreators(b.creators))
      .catch(onFail)
    apiFetch<{ groups: KeywordGroup[] }>('/api/keywords')
      .then((b) => setGroups(b.groups))
      .catch(onFail)
  }, [])

  // Keywords only apply when the source uses them; creators-only runs ignore them entirely (§11.6).
  const usesKeywords = source !== 'creator'
  const usesCreators = source !== 'keyword'
  // Count only the creators the run will actually pull: all platforms, or just the selected one.
  const creatorCount = platform === 'all' ? creators.length : creators.filter((c) => c.platform === platform).length
  const keywords = (market ? groups.filter((g) => g.market === market) : groups).flatMap((g) =>
    g.terms.map((t) => t.term),
  )

  async function poll(jobId: string): Promise<void> {
    try {
      const job = await apiFetch<{ status: string; inserted?: number; error?: string }>(`/api/scrape/${jobId}`)
      if (job.status === 'running') {
        setPill({ status: 'running' })
        setTimeout(() => void poll(jobId), pollIntervalMs)
      } else if (job.status === 'succeeded') {
        setPill({ status: 'succeeded', inserted: job.inserted ?? 0 })
      } else {
        setPill({ status: 'failed', error: job.error })
      }
    } catch (e) {
      setPill({ status: 'failed', error: e instanceof Error ? e.message : 'Scrape failed' })
    }
  }

  async function run(): Promise<void> {
    setPill({ status: 'running' })
    const platforms = platform === 'all' ? ['linkedin', 'twitter', 'substack'] : [platform]
    try {
      const { jobId } = await apiFetch<{ jobId: string }>('/api/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: source as ScrapeMode,
          platforms,
          timeframe,
          market: market || undefined,
          keywords: usesKeywords ? keywords : [],
          includeNotes,
        }),
      })
      await poll(jobId)
    } catch (e) {
      // A 412 is the expected "keys not set" signal — surface the needs list, not a failure.
      if (e instanceof ApiError && e.status === 412) {
        const needs = (e.body as { needs?: string[] } | null)?.needs ?? []
        setPill({ status: 'blocked', needs })
      } else {
        setPill({ status: 'failed', error: e instanceof Error ? e.message : 'Scrape failed' })
      }
    }
  }

  return (
    <section className="manual-scrape">
      <h3>Manual Scrape</h3>
      {loadError && (
        <p className="manual-scrape__error" role="alert">
          Couldn’t load scrape inputs: {loadError}
        </p>
      )}
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
            <option value="substack">Substack</option>
          </select>
        </label>
        <label>
          Time frame
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {TIMEFRAME_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Market
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">All markets</option>
            {groups.map((g) => (
              <option key={g.market} value={g.market}>
                {g.market}
              </option>
            ))}
          </select>
        </label>
        {usesCreators && (platform === 'all' || platform === 'substack') && (
          <label className="manual-scrape__notes">
            <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
            Include Substack Notes (slower)
          </label>
        )}
      </div>

      <button type="button" onClick={run} disabled={pill.status === 'running'}>
        Run scrape now
      </button>
      <span className="manual-scrape__summary">
        {[usesCreators ? `${creatorCount} creators` : null, usesKeywords ? `${keywords.length} keywords` : null]
          .filter(Boolean)
          .join(' + ')}{' '}
        · {TIMEFRAME_LABELS[timeframe] ?? timeframe}
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
