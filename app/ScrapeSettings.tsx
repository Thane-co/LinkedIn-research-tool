'use client'
// Layer 5 — Scrape Settings screen (PRD §11.5 Screen B): API keys + creators + keywords + manual
// scrape, in one page. Keywords editor and Scrape History are placeholders until Layer 6 (§11.6).

import { CreatorManager } from '@/app/CreatorManager'
import { KeywordsEditor } from '@/app/KeywordsEditor'
import { ManualScrape } from '@/app/ManualScrape'
import { ScrapeHistory } from '@/app/ScrapeHistory'
import { SettingsPanel, type SettingsView } from '@/app/SettingsPanel'

export function ScrapeSettings({ view, onSaved }: { view: SettingsView; onSaved?: (v: SettingsView) => void }) {
  return (
    <div className="scrape-settings">
      <header>
        <h1>Scrape Settings</h1>
        <p>Manage your API keys, creator list, and keywords.</p>
      </header>

      <SettingsPanel view={view} onSaved={onSaved} />
      <CreatorManager />
      <KeywordsEditor />
      <ManualScrape />
      <ScrapeHistory />
    </div>
  )
}
