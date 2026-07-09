'use client'
// Layer 6 — KeywordsEditor (PRD §11.5 Screen B, §11.6): per-market keyword sets. Add/remove
// keywords, add/remove markets. A market only persists once it has a keyword, so "Add market"
// creates a local empty group the user can then fill.

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

interface KeywordRow {
  id: string
  market: string
  term: string
}
interface KeywordGroup {
  market: string
  terms: KeywordRow[]
}

export function KeywordsEditor() {
  const [groups, setGroups] = useState<KeywordGroup[]>([])
  const [localMarkets, setLocalMarkets] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newMarket, setNewMarket] = useState('')
  const [error, setError] = useState<string | null>(null)

  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : 'Something went wrong')

  async function load(): Promise<void> {
    try {
      const body = await apiFetch<{ groups: KeywordGroup[] }>('/api/keywords')
      setGroups(body.groups)
      setError(null)
    } catch (e) {
      fail(e)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function addKeyword(market: string): Promise<void> {
    const term = (drafts[market] ?? '').trim()
    if (!term) return
    try {
      await apiFetch('/api/keywords', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market, term }),
      })
      setDrafts((d) => ({ ...d, [market]: '' }))
      await load()
    } catch (e) {
      fail(e)
    }
  }

  async function removeKeyword(id: string): Promise<void> {
    try {
      await apiFetch(`/api/keywords?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      fail(e)
    }
  }

  async function removeMarket(market: string): Promise<void> {
    setLocalMarkets((m) => m.filter((x) => x !== market))
    try {
      await apiFetch(`/api/keywords?market=${encodeURIComponent(market)}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      fail(e)
    }
  }

  function addMarket(): void {
    const name = newMarket.trim()
    if (name && !markets.includes(name)) setLocalMarkets((m) => [...m, name])
    setNewMarket('')
  }

  const byMarket = new Map(groups.map((g) => [g.market, g.terms]))
  const markets = [...new Set([...groups.map((g) => g.market), ...localMarkets])]

  return (
    <section className="keywords" aria-label="keywords">
      <h3>Keywords</h3>
      <p className="placeholder">Per-market keyword sets — used to prefill a manual scrape.</p>

      {error && (
        <p className="keywords__error" role="alert">
          {error}
        </p>
      )}

      {markets.map((market) => (
        <div key={market} className="keywords__market">
          <div className="keywords__market-head">
            <strong>{market}</strong>
            <div className="keywords__add">
              <input
                aria-label={`Add keyword to ${market}`}
                placeholder="Add keyword…"
                value={drafts[market] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [market]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void addKeyword(market)
                  }
                }}
              />
              <button type="button" aria-label={`Add to ${market}`} onClick={() => addKeyword(market)}>
                Add
              </button>
            </div>
            <button
              type="button"
              className="keywords__remove-market"
              aria-label={`remove market ${market}`}
              onClick={() => removeMarket(market)}
            >
              Remove market
            </button>
          </div>
          <div className="keywords__terms">
            {(byMarket.get(market) ?? []).map((k) => (
              <span key={k.id} className="chip">
                {k.term}
                <button type="button" aria-label={`remove keyword ${k.term}`} onClick={() => removeKeyword(k.id)}>
                  ×
                </button>
              </span>
            ))}
            {(byMarket.get(market) ?? []).length === 0 && (
              <span className="keywords__terms-empty">No keywords yet — add one above.</span>
            )}
          </div>
        </div>
      ))}

      <div className="keywords__new">
        <label>
          New market
          <input value={newMarket} onChange={(e) => setNewMarket(e.target.value)} placeholder="e.g. solution engineer" />
        </label>
        <button type="button" onClick={addMarket}>
          Add market
        </button>
      </div>
    </section>
  )
}
