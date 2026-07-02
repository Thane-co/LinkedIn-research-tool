'use client'
// Layer 5 — CreatorManager (PRD §12 step 29, wireframe §11.5 Screen B): Core / Watch lists, add
// (single or bulk import), explicit Demote (core→watch) / Promote (watch→core), Remove.
// Core creators are "pulled every scrape"; the Watch list is "not auto-scraped" (no scheduler).

import { useEffect, useState } from 'react'
import type { CreatorTier, Platform } from '@/lib/types'

interface Creator {
  id: string
  platform: Platform
  profile_url: string
  author_id: string | null
  display_name: string | null
  tier: CreatorTier
  tags: string // JSON array
}

const parseTags = (raw: string): string[] => raw.split(',').map((t) => t.trim()).filter(Boolean)
const parseTagChips = (json: string): string[] => {
  try {
    return JSON.parse(json) as string[]
  } catch {
    return []
  }
}

export function CreatorManager() {
  const [creators, setCreators] = useState<Creator[]>([])
  const [url, setUrl] = useState('')
  const [tags, setTags] = useState('')
  const [tier, setTier] = useState<CreatorTier>('core')
  const [bulk, setBulk] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  const [showWatch, setShowWatch] = useState(false)

  async function load(): Promise<void> {
    const res = await fetch('/api/creators')
    const body = (await res.json()) as { creators: Creator[] }
    setCreators(body.creators)
  }
  useEffect(() => {
    void load()
  }, [])

  async function add(): Promise<void> {
    const input = url.trim()
    if (!input) return
    await fetch('/api/creators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: [input], tier, tags: parseTags(tags) }),
    })
    setUrl('')
    setTags('')
    await load()
  }

  async function bulkImport(): Promise<void> {
    const inputs = bulk.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    if (inputs.length === 0) return
    await fetch('/api/creators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, tier }),
    })
    setBulk('')
    setShowBulk(false)
    await load()
  }

  async function setTierFor(id: string, next: CreatorTier): Promise<void> {
    await fetch('/api/creators', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, tier: next }),
    })
    await load()
  }

  async function remove(id: string): Promise<void> {
    await fetch(`/api/creators?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  const core = creators.filter((c) => c.tier === 'core')
  const watch = creators.filter((c) => c.tier === 'watch')

  const nameOf = (c: Creator): string => c.display_name ?? c.author_id ?? c.profile_url
  const row = (c: Creator, action: { label: string; to: CreatorTier }) => (
    <li key={c.id} className="creators__row">
      <span className="creators__name">{nameOf(c)}</span>
      <span className="creators__slug">{c.profile_url}</span>
      <span className="creators__tags">
        {parseTagChips(c.tags).map((t) => (
          <span key={t} className="chip chip--tag">
            {t}
          </span>
        ))}
      </span>
      <button type="button" onClick={() => setTierFor(c.id, action.to)}>
        {action.label}
      </button>
      <button type="button" aria-label={`remove ${nameOf(c)}`} onClick={() => remove(c.id)}>
        Remove
      </button>
    </li>
  )

  return (
    <section className="creators">
      <div className="creators__head">
        <h2>Core Creators</h2>
        <span className="creators__count">{core.length} — pulled every scrape</span>
        <button type="button" onClick={() => setShowBulk((s) => !s)}>
          Bulk import
        </button>
      </div>

      {showBulk && (
        <div className="creators__bulk">
          <label>
            Bulk import (one per line)
            <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={4} />
          </label>
          <button type="button" onClick={bulkImport}>
            Import
          </button>
        </div>
      )}

      <div className="creators__add">
        <label>
          Profile URL or @handle
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="LinkedIn URL, X URL, or @handle" />
        </label>
        <label>
          Tags
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ai, founder" />
        </label>
        <label>
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value as CreatorTier)}>
            <option value="core">Core</option>
            <option value="watch">Watch</option>
          </select>
        </label>
        <button type="button" onClick={add}>
          Add
        </button>
      </div>

      <ul className="creators__list">{core.map((c) => row(c, { label: 'Demote', to: 'watch' }))}</ul>

      <div className="creators__watch">
        <button type="button" aria-expanded={showWatch} onClick={() => setShowWatch((s) => !s)}>
          Watch List — {watch.length} creators — not auto-scraped
        </button>
        {showWatch && <ul className="creators__list">{watch.map((c) => row(c, { label: 'Promote', to: 'core' }))}</ul>}
      </div>
    </section>
  )
}
