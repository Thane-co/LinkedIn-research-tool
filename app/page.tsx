'use client'
// Layer 5 — app entry (PRD §12 step 31, wireframe §11.5). On mount, check /api/settings readiness;
// route between the Search screen and the Scrape Settings screen. On first run (keys missing) the app
// opens on Settings and Search is disabled until Apify + Voyage are set.

import { useEffect, useState } from 'react'
import { DashboardClient } from '@/app/DashboardClient'
import { ScrapeSettings } from '@/app/ScrapeSettings'
import type { SettingsView } from '@/app/SettingsPanel'

export default function Page() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [route, setRoute] = useState<'search' | 'settings'>('settings')

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((v: SettingsView) => {
        setView(v)
        setRoute(v.ready.apify && v.ready.voyage ? 'search' : 'settings')
      })
  }, [])

  if (!view) {
    return (
      <main>
        <p>Loading…</p>
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
        <button type="button" aria-pressed={route === 'settings'} onClick={() => setRoute('settings')}>
          Scrape Settings
        </button>
      </nav>

      {route === 'search' ? <DashboardClient /> : <ScrapeSettings view={view} onSaved={setView} />}
    </main>
  )
}
