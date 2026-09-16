'use client'
// Layer 5 — SettingsPanel + onboarding gate (PRD §12 step 26): paste Apify token, Voyage key,
// optional Anthropic key; edit actor ids; "Test connection" per provider (green/red). On first run
// (no keys) the app opens here and gates Scrape until Apify+Voyage are set.

import { useState } from 'react'
import { apiFetch } from '@/lib/api-client'

export interface SettingsView {
  settings: Record<string, string> // masked: secrets are 'set' | 'unset'
  ready: { apify: boolean; voyage: boolean; anthropic: boolean; assemblyai: boolean }
}

type ProbeResult = { ok: boolean; error?: string }
type TestResults = { apify: ProbeResult; voyage: ProbeResult; anthropic: ProbeResult; assemblyai: ProbeResult }

const SECRET_FIELDS = [
  { key: 'apify_api_token', label: 'Apify API token' },
  { key: 'voyage_api_key', label: 'Voyage API key' },
  { key: 'anthropic_api_key', label: 'Anthropic API key (optional)' },
  { key: 'assemblyai_api_key', label: 'AssemblyAI API key (Instagram video transcripts)' },
] as const
// Each actor field links to its Apify store page so you can open the actor you're pointing at.
const ACTOR_FIELDS: readonly { key: string; label: string; href?: string }[] = [
  { key: 'apify_keyword_actor_id', label: 'LinkedIn keyword actor', href: 'https://apify.com/harvestapi/linkedin-post-search' },
  { key: 'apify_profile_actor_id', label: 'LinkedIn profile-posts actor', href: 'https://apify.com/harvestapi/linkedin-profile-posts' },
  { key: 'apify_profile_detail_actor_id', label: 'LinkedIn profile-details actor', href: 'https://apify.com/harvestapi/linkedin-profile-scraper' },
  { key: 'apify_tweet_actor_id', label: 'Twitter actor', href: 'https://apify.com/apidojo/tweet-scraper' },
  { key: 'apify_substack_actor_id', label: 'Substack actor', href: 'https://apify.com/brilliant_gum/substack-insights-scraper' },
  { key: 'apify_instagram_actor_id', label: 'Instagram actor', href: 'https://apify.com/apify/instagram-post-scraper' },
  { key: 'apify_comments_actor_id', label: 'LinkedIn comments actor (your own posts only)', href: 'https://apify.com/harvestapi/linkedin-post-comments' },
  // §23: plain config rather than an actor, edited the same way. Comment scraping is refused until set.
  { key: 'own_linkedin_author_id', label: 'Your LinkedIn author id (the slug in linkedin.com/in/…)' },
]
const PROVIDERS = ['apify', 'voyage', 'anthropic', 'assemblyai'] as const

export function SettingsPanel({ view, onSaved }: { view: SettingsView; onSaved?: (v: SettingsView) => void }) {
  const [settings, setSettings] = useState(view.settings)
  const [ready, setReady] = useState(view.ready)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [actors, setActors] = useState<Record<string, string>>(() =>
    Object.fromEntries(ACTOR_FIELDS.map((f) => [f.key, view.settings[f.key] ?? ''])),
  )
  const [results, setResults] = useState<TestResults | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const gated = !ready.apify || !ready.voyage

  async function save() {
    const partial: Record<string, string> = {}
    for (const f of SECRET_FIELDS) {
      const v = secrets[f.key]
      if (v !== undefined && v !== '') partial[f.key] = v // only send edited secrets
    }
    for (const f of ACTOR_FIELDS) {
      const v = actors[f.key] ?? ''
      if (v !== (settings[f.key] ?? '')) partial[f.key] = v // only send changed actor ids
    }
    setBusy(true)
    setError(null)
    try {
      const next = await apiFetch<SettingsView>('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(partial),
      })
      setSettings(next.settings)
      setReady(next.ready)
      setSecrets({})
      onSaved?.(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    setError(null)
    try {
      setResults(await apiFetch<TestResults>('/api/settings/test', { method: 'POST' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed')
    }
  }

  return (
    <section className="settings">
      <h2>Settings — your API keys stay on this machine</h2>
      {gated && (
        <div className="settings__gate" data-testid="settings-gate" role="alert">
          Add your Apify token and Voyage key to enable scraping.
        </div>
      )}

      {SECRET_FIELDS.map((f) => (
        <label key={f.key} className="settings__field">
          {f.label}
          <input
            type="password"
            value={secrets[f.key] ?? ''}
            placeholder={settings[f.key] === 'set' ? '•••• (saved)' : 'not set'}
            onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
          />
        </label>
      ))}

      {ACTOR_FIELDS.map((f) => (
        <label key={f.key} className="settings__field">
          <span className="settings__field-head">
            {f.label}
            {f.href && (
              <a className="settings__actor-link" href={f.href} target="_blank" rel="noreferrer">
                view actor ↗
              </a>
            )}
          </span>
          <input
            value={actors[f.key] ?? ''}
            onChange={(e) => setActors((a) => ({ ...a, [f.key]: e.target.value }))}
          />
        </label>
      ))}

      <div className="settings__actions">
        <button type="button" onClick={save} disabled={busy}>
          Save
        </button>
        <button type="button" onClick={testConnection} disabled={busy}>
          Test connection
        </button>
      </div>

      {error && (
        <p className="settings__error" data-testid="settings-error" role="alert">
          {error}
        </p>
      )}

      {results && (
        <ul className="settings__results">
          {PROVIDERS.map((p) => (
            <li key={p} data-testid={`test-${p}`} data-ok={String(results[p].ok)}>
              {p}: {results[p].ok ? 'OK' : (results[p].error ?? 'failed')}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
