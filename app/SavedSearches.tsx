'use client'
// Layer 6 — SavedSearches (PRD §11.5 Screen A, §11.6): named filter presets. Select one to apply
// its params to the filter row; save the current filters under a name; delete. Purely a preset —
// selecting re-queries live (the parent owns fetching).

import { useEffect, useState } from 'react'

interface SavedSearchRow {
  id: string
  name: string
  params: string // JSON
}

export function SavedSearches<T>({ current, onApply }: { current: T; onApply: (params: T) => void }) {
  const [searches, setSearches] = useState<SavedSearchRow[]>([])
  const [name, setName] = useState('')

  async function load(): Promise<void> {
    const res = await fetch('/api/saved-searches')
    const body = (await res.json()) as { searches: SavedSearchRow[] }
    setSearches(body.searches)
  }
  useEffect(() => {
    void load()
  }, [])

  function apply(id: string): void {
    const found = searches.find((s) => s.id === id)
    if (found) onApply(JSON.parse(found.params) as T)
  }

  async function save(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    await fetch('/api/saved-searches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed, params: current }),
    })
    setName('')
    await load()
  }

  async function remove(id: string): Promise<void> {
    await fetch(`/api/saved-searches?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="saved-searches">
      <label className="saved-searches__select">
        Saved searches ({searches.length})
        <select value="" onChange={(e) => e.target.value && apply(e.target.value)}>
          <option value="">Select a saved search…</option>
          {searches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="saved-searches__save">
        Preset name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this search" />
      </label>
      <button type="button" onClick={save}>
        Save
      </button>
      {searches.map((s) => (
        <button key={s.id} type="button" aria-label={`delete saved search ${s.name}`} onClick={() => remove(s.id)}>
          ×{s.name}
        </button>
      ))}
    </div>
  )
}
