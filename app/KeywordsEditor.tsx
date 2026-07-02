'use client'
// Layer 6 — KeywordsEditor (PRD §11.5 Screen B, §11.6): per-market keyword sets. Add/remove
// keywords, add/remove markets. A market only persists once it has a keyword, so "Add market"
// creates a local empty group the user can then fill.

import { useEffect, useState } from 'react'

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

  async function load(): Promise<void> {
    const res = await fetch('/api/keywords')
    const body = (await res.json()) as { groups: KeywordGroup[] }
    setGroups(body.groups)
  }
  useEffect(() => {
    void load()
  }, [])

  async function addKeyword(market: string): Promise<void> {
    const term = (drafts[market] ?? '').trim()
    if (!term) return
    await fetch('/api/keywords', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market, term }),
    })
    setDrafts((d) => ({ ...d, [market]: '' }))
    await load()
  }

  async function removeKeyword(id: string): Promise<void> {
    await fetch(`/api/keywords?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  async function removeMarket(market: string): Promise<void> {
    setLocalMarkets((m) => m.filter((x) => x !== market))
    await fetch(`/api/keywords?market=${encodeURIComponent(market)}`, { method: 'DELETE' })
    await load()
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

      {markets.map((market) => (
        <div key={market} className="keywords__market">
          <div className="keywords__market-head">
            <strong>{market}</strong>
            <button type="button" aria-label={`remove market ${market}`} onClick={() => removeMarket(market)}>
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
            <label className="keywords__add">
              {`Add keyword to ${market}`}
              <input
                value={drafts[market] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [market]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void addKeyword(market)
                  }
                }}
              />
            </label>
            <button type="button" onClick={() => addKeyword(market)}>
              {`Add to ${market}`}
            </button>
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
