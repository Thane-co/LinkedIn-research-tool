'use client'
// Layer 5 — Scrape Settings screen (PRD §11.5 Screen B): API keys + Core/Watch creators + manual
// scrape, in one page. Keywords editor and Scrape History are placeholders until Layer 6 (§11.6).

import { CreatorManager } from '@/app/CreatorManager'
import { ManualScrape } from '@/app/ManualScrape'
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

      <section className="keywords" aria-label="keywords">
        <h3>Keywords</h3>
        <p className="placeholder">Per-market keyword sets — lands in Layer 6 (§11.6).</p>
      </section>

      <ManualScrape />

      <section className="history" aria-label="scrape history">
        <h3>Scrape History</h3>
        <p className="placeholder">Last 20 runs — lands in Layer 6 (§11.6).</p>
      </section>
    </div>
  )
}
