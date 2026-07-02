'use client'
// Layer 5 — CreatorManager (PRD §12 step 29, wireframe §11.5 Screen B): a single creator list —
// every creator is part of the scrape set (tier 'core' under the hood). Add (single or bulk import),
// Remove. No watch/demote UI (no scheduler, so the tracked-vs-scraped split added nothing).

import { useEffect, useState } from 'react'

interface Creator {
  id: string
  platform: 'linkedin' | 'twitter'
  profile_url: string
  author_id: string | null
  display_name: string | null
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
  const [bulk, setBulk] = useState('')
  const [showBulk, setShowBulk] = useState(false)

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
      body: JSON.stringify({ inputs: [input], tags: parseTags(tags) }),
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
      body: JSON.stringify({ inputs }),
    })
    setBulk('')
    setShowBulk(false)
    await load()
  }

  async function remove(id: string): Promise<void> {
    await fetch(`/api/creators?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  const nameOf = (c: Creator): string => c.display_name ?? c.author_id ?? c.profile_url

  return (
    <section className="creators">
      <div className="creators__head">
        <h2>Creators</h2>
        <span className="creators__count">{creators.length} tracked</span>
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
        <button type="button" onClick={add}>
          Add
        </button>
      </div>

      <ul className="creators__list">
        {creators.map((c) => (
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
            <button type="button" aria-label={`remove ${nameOf(c)}`} onClick={() => remove(c.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
