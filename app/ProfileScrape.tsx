'use client'
// Layer 5 — ProfileScrape (§19): scrape ONE LinkedIn profile's full details + follower count. Distinct
// from ManualScrape (which scrapes POSTS): this fetches a single profile synchronously, shows its
// follower/connection counts + headline, and lists the profiles scraped so far. Fetches via apiFetch;
// a 412 surfaces the "add your Apify key" prompt (same pattern as Manual Scrape).

import { useCallback, useEffect, useState } from 'react'
import type { ProfileRow } from '@/lib/types'
import { ApiError, apiFetch } from '@/lib/api-client'
import { safeHref } from '@/lib/pure/url'

type Pill =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded' }
  | { status: 'failed'; error?: string }
  | { status: 'blocked'; needs: string[] }

export function ProfileScrape() {
  const [query, setQuery] = useState('')
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [pill, setPill] = useState<Pill>({ status: 'idle' })
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadProfiles = useCallback(() => {
    apiFetch<{ profiles: ProfileRow[] }>('/api/profile')
      .then((b) => setProfiles(b.profiles))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Failed to load'))
  }, [])

  useEffect(() => loadProfiles(), [loadProfiles])

  async function run(): Promise<void> {
    const q = query.trim()
    if (!q) return
    setPill({ status: 'running' })
    try {
      await apiFetch<{ profile: ProfileRow }>('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })
      setPill({ status: 'succeeded' })
      loadProfiles()
    } catch (e) {
      // A 412 is the expected "key not set" signal — surface the needs list, not a failure.
      if (e instanceof ApiError && e.status === 412) {
        const needs = (e.body as { needs?: string[] } | null)?.needs ?? []
        setPill({ status: 'blocked', needs })
      } else {
        setPill({ status: 'failed', error: e instanceof Error ? e.message : 'Scrape failed' })
      }
    }
  }

  return (
    <details className="profile-scrape" open>
      <summary className="profile-scrape__summary">
        <h3>Profile Scrape</h3>
        <span className="profile-scrape__count">{profiles.length} scraped</span>
      </summary>

      <div className="profile-scrape__body">
        <p className="profile-scrape__hint">Pull a LinkedIn profile’s full details + follower count.</p>
        {loadError && (
          <p className="profile-scrape__error" role="alert">
            Couldn’t load saved profiles: {loadError}
          </p>
        )}
        <div className="profile-scrape__controls">
          <label>
            Profile URL or handle
            <input
              type="text"
              value={query}
              placeholder="https://www.linkedin.com/in/basiakubicka/"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button type="button" onClick={run} disabled={pill.status === 'running' || !query.trim()}>
            Scrape profile
          </button>
          <span className="profile-scrape__pill" data-status={pill.status} role="status">
            {pill.status === 'running' && 'Scraping…'}
            {pill.status === 'succeeded' && 'Profile scraped'}
            {pill.status === 'failed' && 'Scrape failed'}
            {pill.status === 'blocked' && `Add ${pill.needs.join(', ')} in Settings`}
          </span>
        </div>

        {profiles.length > 0 && (
          <ul className="profile-scrape__list">
            {profiles.map((p) => (
              <li key={p.id} className="profile-scrape__row">
                <div className="profile-scrape__who">
                  <strong>{p.name ?? p.id}</strong>
                  {p.headline && <span className="profile-scrape__headline">{p.headline}</span>}
                </div>
                <div className="profile-scrape__stats">
                  <span className="profile-scrape__followers">{p.followers.toLocaleString()} followers</span>
                  <span>{p.connections.toLocaleString()} connections</span>
                  {safeHref(p.url) && (
                    <a href={safeHref(p.url)} target="_blank" rel="noreferrer noopener">
                      View
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
