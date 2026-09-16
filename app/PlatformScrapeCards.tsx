'use client'
// Layer 5 — PlatformScrapeCards (PRD §11.8). Replaces the single bundled ManualScrape control.
//
// One card per platform, because the platforms are not alike: LinkedIn is 112 curated creators,
// Twitter is open keyword discovery with a likes floor, Instagram has no keyword mode at all, and
// Substack has a Notes feed that doubles the run. Each card owns its own source toggles, timeframe
// and actor option, remembers them in the `scrape_prefs` setting, and POSTs only its own platform.
//
// There is still NO scheduler (local, no-cron) — a card runs when you press its button.

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import {
  DEFAULT_SCRAPE_PREFS,
  PLATFORMS,
  PLATFORM_SUPPORTS_KEYWORDS,
  parseScrapePrefs,
  prefsToMode,
  serializeScrapePrefs,
  type PlatformPrefs,
  type ScrapePrefs,
} from '@/lib/pure/scrape-prefs'
import { formatAgo } from '@/lib/pure/relative-time'
import type { Platform, Timeframe } from '@/lib/types'

type Pill =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded'; inserted: number }
  | { status: 'failed'; error?: string }
  | { status: 'blocked'; needs: string[] }

interface PlatformStatus {
  lastScrapedAt: string | null
  creators: number
}

interface KeywordGroup {
  market: string
  terms: { term: string }[]
}

const LABELS: Record<Platform, string> = {
  linkedin: 'LinkedIn',
  twitter: 'X / Twitter',
  substack: 'Substack',
  instagram: 'Instagram',
}

const TIMEFRAMES: Timeframe[] = ['24h', '3d', 'week', 'month', '3months', 'all']
const TIMEFRAME_LABELS: Partial<Record<Timeframe, string>> = { all: 'All time (full history)' }

const EMPTY_STATUS: Record<Platform, PlatformStatus> = {
  linkedin: { lastScrapedAt: null, creators: 0 },
  twitter: { lastScrapedAt: null, creators: 0 },
  substack: { lastScrapedAt: null, creators: 0 },
  instagram: { lastScrapedAt: null, creators: 0 },
}

export function PlatformScrapeCards({ pollIntervalMs = 1500 }: { pollIntervalMs?: number }) {
  const [prefs, setPrefs] = useState<ScrapePrefs>(DEFAULT_SCRAPE_PREFS)
  const [status, setStatus] = useState<Record<Platform, PlatformStatus>>(EMPTY_STATUS)
  const [groups, setGroups] = useState<KeywordGroup[]>([])
  const [pills, setPills] = useState<Partial<Record<Platform, Pill>>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  const keywordCount = groups.reduce((n, g) => n + g.terms.length, 0)

  const loadStatus = useCallback(async (): Promise<void> => {
    const body = await apiFetch<{ platforms: Record<Platform, PlatformStatus> }>('/api/scrape/status')
    setStatus(body.platforms)
  }, [])

  useEffect(() => {
    const fail = (e: unknown): void => setLoadError(e instanceof Error ? e.message : 'Failed to load')
    void loadStatus().catch(fail)
    apiFetch<{ groups: KeywordGroup[] }>('/api/keywords')
      .then((b) => setGroups(b.groups))
      .catch(fail)
    apiFetch<{ settings: Record<string, string> }>('/api/settings')
      .then((b) => setPrefs(parseScrapePrefs(b.settings.scrape_prefs)))
      .catch(fail)
  }, [loadStatus])

  /** Update one platform's prefs and persist the whole map — the cards must survive a reload. */
  function update(platform: Platform, patch: Partial<PlatformPrefs>): void {
    setPrefs((current) => {
      const next: ScrapePrefs = { ...current, [platform]: { ...current[platform], ...patch } }
      apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scrape_prefs: serializeScrapePrefs(next) }),
      }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Failed to save scrape settings'))
      return next
    })
  }

  const setPill = (platform: Platform, pill: Pill): void => setPills((p) => ({ ...p, [platform]: pill }))

  async function poll(platform: Platform, jobId: string): Promise<void> {
    try {
      const job = await apiFetch<{ status: string; inserted?: number; error?: string }>(`/api/scrape/${jobId}`)
      if (job.status === 'running') {
        setPill(platform, { status: 'running' })
        setTimeout(() => void poll(platform, jobId), pollIntervalMs)
      } else if (job.status === 'succeeded') {
        setPill(platform, { status: 'succeeded', inserted: job.inserted ?? 0 })
        void loadStatus().catch(() => undefined) // refresh "last scraped"; a failure here is cosmetic
      } else {
        setPill(platform, { status: 'failed', error: job.error })
      }
    } catch (e) {
      setPill(platform, { status: 'failed', error: e instanceof Error ? e.message : 'Scrape failed' })
    }
  }

  async function run(platform: Platform): Promise<void> {
    const p = prefs[platform]
    const mode = prefsToMode(p)
    if (!mode) return // guarded by the disabled button; belt and braces
    setPill(platform, { status: 'running' })

    const keywords = p.keywords ? groups.flatMap((g) => g.terms.map((t) => t.term)) : []
    try {
      const { jobId } = await apiFetch<{ jobId: string }>('/api/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platforms: [platform],
          mode,
          timeframe: p.timeframe,
          keywords,
          ...(p.includeNotes !== undefined && { includeNotes: p.includeNotes }),
          // Keyword runs only — the job layer never applies a floor to a creator run (§11.8).
          ...(p.minimumFavorites !== undefined && p.keywords && { minimumFavorites: p.minimumFavorites }),
        }),
      })
      await poll(platform, jobId)
    } catch (e) {
      // A 412 is the expected "keys not set" signal — surface the needs list, not a failure.
      if (e instanceof ApiError && e.status === 412) {
        setPill(platform, { status: 'blocked', needs: (e.body as { needs?: string[] } | null)?.needs ?? [] })
      } else {
        setPill(platform, { status: 'failed', error: e instanceof Error ? e.message : 'Scrape failed' })
      }
    }
  }

  const now = new Date()

  return (
    <section className="platform-scrape">
      <h2>Scrape</h2>
      <p className="platform-scrape__hint">
        Each platform runs on its own. Keywords come from the Keywords list ({keywordCount} terms).
      </p>
      {loadError && (
        <p className="platform-scrape__error" role="alert">
          {loadError}
        </p>
      )}

      <div className="platform-scrape__cards">
        {PLATFORMS.map((platform) => {
          const p = prefs[platform]
          const s = status[platform]
          const pill = pills[platform] ?? { status: 'idle' as const }
          const canRun = prefsToMode(p) !== null

          return (
            <fieldset key={platform} className="scrape-card" data-platform={platform}>
              <legend className="scrape-card__legend">
                {LABELS[platform]}
                <span className="scrape-card__last">{`last scrape: ${formatAgo(s.lastScrapedAt, now)}`}</span>
              </legend>

              <div className="scrape-card__sources">
                <label>
                  <input
                    type="checkbox"
                    checked={p.creators}
                    onChange={(e) => update(platform, { creators: e.target.checked })}
                  />
                  Creators ({s.creators})
                </label>

                {PLATFORM_SUPPORTS_KEYWORDS[platform] && (
                  <label>
                    <input
                      type="checkbox"
                      checked={p.keywords}
                      onChange={(e) => update(platform, { keywords: e.target.checked })}
                    />
                    Keywords ({keywordCount})
                  </label>
                )}

                {p.includeNotes !== undefined && (
                  <label>
                    <input
                      type="checkbox"
                      checked={p.includeNotes}
                      onChange={(e) => update(platform, { includeNotes: e.target.checked })}
                    />
                    Notes (slower)
                  </label>
                )}
              </div>

              <div className="scrape-card__options">
                <label>
                  Time frame
                  <select
                    value={p.timeframe}
                    onChange={(e) => update(platform, { timeframe: e.target.value as Timeframe })}
                  >
                    {TIMEFRAMES.map((t) => (
                      <option key={t} value={t}>
                        {TIMEFRAME_LABELS[t] ?? t}
                      </option>
                    ))}
                  </select>
                </label>

                {platform === 'twitter' && (
                  <label title="X applies this in its own search index, so the run returns — and bills for — fewer, better tweets.">
                    Min likes
                    <input
                      type="number"
                      min={0}
                      step={50}
                      value={p.minimumFavorites ?? 0}
                      onChange={(e) => update(platform, { minimumFavorites: Number(e.target.value) || undefined })}
                    />
                  </label>
                )}
              </div>

              <div className="scrape-card__actions">
                <button type="button" onClick={() => void run(platform)} disabled={!canRun || pill.status === 'running'}>
                  Run {LABELS[platform]}
                </button>
                <span className="scrape-card__pill" data-status={pill.status} role="status">
                  {pill.status === 'running' && 'Scraping…'}
                  {pill.status === 'succeeded' && `Complete · ${pill.inserted} new`}
                  {pill.status === 'failed' && `Failed${pill.error ? `: ${pill.error}` : ''}`}
                  {pill.status === 'blocked' && `Add ${pill.needs.join(', ')} in Settings`}
                </span>
              </div>
            </fieldset>
          )
        })}
      </div>
    </section>
  )
}
