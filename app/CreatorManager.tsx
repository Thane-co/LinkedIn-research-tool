'use client'
// Layer 5 — CreatorManager (PRD §11.8, §12 step 29): the creator set as a PERSON x PLATFORM table.
// Accounts are stored one row each, but read one row per person (grouped by `persona`, §17.2), so
// "how many of these people do we follow on X?" is answerable at a glance and every empty cell is a
// visible gap with an add button on it. Add (single or bulk import), Remove, and a one-shot
// "Link accounts by name" that backfills personas from display names.
// Every creator here IS the scrape set; there is no tier/watch split and no demote UI.

import { useEffect, useState, type ChangeEvent } from 'react'
import { parseCreatorCsv } from '@/lib/pure/csv'
import { derivePersonaKey } from '@/lib/pure/persona'
import { countByPlatform, groupCreatorsByPerson, shortAccountLabel, TABLE_PLATFORMS } from '@/lib/pure/creator-table'
import { apiFetch } from '@/lib/api-client'
import type { CreatorRow, Platform } from '@/lib/types'

/** Read a File as text via FileReader (works in every browser and under jsdom, unlike File.text()). */
const readFileText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsText(file)
  })

const parseTags = (raw: string): string[] => raw.split(',').map((t) => t.trim()).filter(Boolean)
const parseTagChips = (json: string): string[] => {
  try {
    return JSON.parse(json) as string[]
  } catch {
    return []
  }
}

export function CreatorManager() {
  const [creators, setCreators] = useState<CreatorRow[]>([])
  const [url, setUrl] = useState('')
  const [tags, setTags] = useState('')
  const [person, setPerson] = useState('')
  const [bulk, setBulk] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linked, setLinked] = useState<number | null>(null)

  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : 'Something went wrong')

  async function load(): Promise<void> {
    try {
      const body = await apiFetch<{ creators: CreatorRow[] }>('/api/creators')
      setCreators(body.creators)
      setError(null)
    } catch (e) {
      fail(e)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function add(): Promise<void> {
    const input = url.trim()
    if (!input) return
    try {
      await apiFetch('/api/creators', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: [input],
          tags: parseTags(tags),
          ...(person.trim() && { persona: person.trim() }),
        }),
      })
      setUrl('')
      setTags('')
      setPerson('')
      await load()
    } catch (e) {
      fail(e)
    }
  }

  /** POST a list of raw url/@handle strings, then reload. Shared by paste + CSV import. */
  async function importInputs(inputs: string[]): Promise<void> {
    if (inputs.length === 0) return
    try {
      await apiFetch('/api/creators', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
      })
      await load()
    } catch (e) {
      fail(e)
    }
  }

  async function bulkImport(): Promise<void> {
    const inputs = bulk.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    if (inputs.length === 0) return
    await importInputs(inputs)
    setBulk('')
    setShowBulk(false)
  }

  async function onCsvFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-selected
    if (!file) return
    await importInputs(parseCreatorCsv(await readFileText(file)))
  }

  /** One-shot: derive persona from display_name wherever it's unset, so rows group by person. */
  async function linkByName(): Promise<void> {
    try {
      const body = await apiFetch<{ updated: number; creators: CreatorRow[] }>('/api/creators/backfill-personas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      setCreators(body.creators)
      setLinked(body.updated)
      setError(null)
    } catch (e) {
      fail(e)
    }
  }

  /** Clicking an empty cell prefills the Person field so the new account joins that person's row. */
  function startAdd(personKey: string): void {
    setPerson(personKey)
    setUrl('')
  }

  async function remove(id: string): Promise<void> {
    try {
      await apiFetch(`/api/creators?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      fail(e)
    }
  }

  const nameOf = (c: CreatorRow): string => c.display_name ?? c.author_id ?? c.profile_url

  const people = groupCreatorsByPerson(creators)
  const counts = countByPlatform(creators)
  const PLATFORM_LABELS: Record<Platform, string> = {
    linkedin: 'LinkedIn',
    twitter: 'X',
    substack: 'Substack',
    instagram: 'Instagram',
  }

  return (
    <details className="creators" open>
      <summary className="creators__summary">
        <h2>Creators</h2>
        <span className="creators__count">
          {people.length} people · {creators.length} accounts
        </span>
        <span className="creators__platform-counts">
          {TABLE_PLATFORMS.map((p) => `${counts[p]} ${PLATFORM_LABELS[p]}`).join(' · ')}
        </span>
      </summary>

      <div className="creators__body">
        <div className="creators__head-actions">
          <label className="creators__csv">
            Upload CSV
            <input type="file" accept=".csv,text/csv" onChange={onCsvFile} />
          </label>
          <button type="button" onClick={() => setShowBulk((s) => !s)}>
            Bulk import
          </button>
          <button type="button" onClick={() => void linkByName()} title="Group accounts that share a display name onto one person">
            Link accounts by name
          </button>
          {linked !== null && <span className="creators__linked" role="status">{`Linked ${linked} account(s)`}</span>}
        </div>

        {error && (
          <p className="creators__error" role="alert">
            {error}
          </p>
        )}

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
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="LinkedIn / X / Substack / Instagram URL, or @handle" />
          </label>
          <label>
            Tags
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ai, founder" />
          </label>
          <label>
            Person
            <input
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              placeholder="auto from name — set to link accounts"
            />
          </label>
          <button type="button" onClick={add}>
            Add
          </button>
        </div>

        <table className="creators__table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              {TABLE_PLATFORMS.map((p) => (
                <th key={p} scope="col">
                  {PLATFORM_LABELS[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((row) => (
              <tr key={row.key} className="creators__person-row">
                <th scope="row" className="creators__name">
                  <span className="creators__person-label">{row.label}</span>
                  {/* the persona key is what actually groups the row — surface it only when it adds
                      information, i.e. it is not simply the label normalized */}
                  {derivePersonaKey(row.label) !== row.key && !row.key.startsWith('id:') && (
                    <span className="chip chip--person" title="person key (links accounts across platforms)">
                      {row.key}
                    </span>
                  )}
                </th>
                {TABLE_PLATFORMS.map((platform) => (
                  <td key={platform} className="creators__cell" data-platform={platform}>
                    {row.accounts[platform].length === 0 ? (
                      <button
                        type="button"
                        className="creators__add-cell"
                        aria-label={`add ${PLATFORM_LABELS[platform]} for ${row.label}`}
                        onClick={() => startAdd(row.key)}
                      >
                        + add
                      </button>
                    ) : (
                      row.accounts[platform].map((c) => (
                        <span key={c.id} className="creators__account">
                          <span className="creators__slug" title={c.profile_url}>
                            {shortAccountLabel(c)}
                          </span>
                          {parseTagChips(c.tags).map((t) => (
                            <span key={t} className="chip chip--tag">
                              {t}
                            </span>
                          ))}
                          <button type="button" aria-label={`remove ${nameOf(c)}`} onClick={() => remove(c.id)}>
                            Remove
                          </button>
                        </span>
                      ))
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
