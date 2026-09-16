'use client'
// Layer 5 — Scrape Settings screen (PRD §11.5 Screen B): API keys + creators + keywords + manual
// scrape, in one page. Keywords editor and Scrape History are placeholders until Layer 6 (§11.6).

import { CreatorManager } from '@/app/CreatorManager'
import { KeywordsEditor } from '@/app/KeywordsEditor'
import { ManualScrape } from '@/app/ManualScrape'
import { PlatformScrapeCards } from '@/app/PlatformScrapeCards'
import { ProfileScrape } from '@/app/ProfileScrape'
import { ScrapeHistory } from '@/app/ScrapeHistory'
import { SettingsPanel, type SettingsView } from '@/app/SettingsPanel'

export function ScrapeSettings({ view, onSaved }: { view: SettingsView; onSaved?: (v: SettingsView) => void }) {
  return (
    <div className="scrape-settings">
      <header>
        <h1>Settings</h1>
        <p>Manage your API keys, creators, keywords, and per-platform scrapes.</p>
      </header>

      <SettingsPanel view={view} onSaved={onSaved} />
      <CreatorManager />
      <KeywordsEditor />
      <PlatformScrapeCards />
      {/* Kept below the per-platform cards as the escape hatch: one run across several platforms at
          once, and the only place to scope a run to a single market (§11.8). */}
      <details className="manual-scrape-fallback">
        <summary>Run several platforms at once</summary>
        <ManualScrape />
      </details>
      <ProfileScrape />
      <ScrapeHistory />
    </div>
  )
}
