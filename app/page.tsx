'use client'
// Layer 5 — app entry (PRD §12 step 31, wireframe §11.5). On mount, check /api/settings readiness;
// route between the Search screen and the Scrape Settings screen. On first run (keys missing) the app
// opens on Settings and Search is disabled until Apify + Voyage are set.

import { useCallback, useEffect, useState } from 'react'
import { DashboardClient } from '@/app/DashboardClient'
import { GrowthBoard } from '@/app/GrowthBoard'
import { ScrapeSettings } from '@/app/ScrapeSettings'
import type { SettingsView } from '@/app/SettingsPanel'
import { apiFetch } from '@/lib/api-client'

export default function Page() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [route, setRoute] = useState<'search' | 'growth' | 'settings'>('settings')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    apiFetch<SettingsView>('/api/settings')
      .then((v) => {
        setView(v)
        setRoute(v.ready.apify && v.ready.voyage ? 'search' : 'settings')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load settings'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!view) {
    return (
      <main>
        {error ? (
          <div className="app-error" role="alert">
            <p>Couldn’t load settings: {error}</p>
            <button type="button" onClick={load}>
              Retry
            </button>
          </div>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    )
  }

  const ready = view.ready.apify && view.ready.voyage

  return (
    <main>
      <nav className="app-nav" aria-label="primary">
        <button type="button" aria-pressed={route === 'search'} disabled={!ready} onClick={() => setRoute('search')}>
          Search
        </button>
        <button type="button" aria-pressed={route === 'growth'} disabled={!ready} onClick={() => setRoute('growth')}>
          Growth
        </button>
        <button type="button" aria-pressed={route === 'settings'} onClick={() => setRoute('settings')}>
          Settings
        </button>
      </nav>

      {route === 'search' && <DashboardClient />}
      {route === 'growth' && <GrowthBoard />}
      {route === 'settings' && <ScrapeSettings view={view} onSaved={setView} />}
    </main>
  )
}
