'use client'
// Layer 5 — DashboardFilterBar (PRD §12 step 28, wireframe §11.5 Screen A): a single search row —
// keyword chips, creator dropdown (count), ♥ minLikes / ↗ minShares / ✕ minXFactor, sort, timeframe
// (+ custom range), market, platform, Search. Group-by-image / Discover-trends live in the header
// (DashboardClient), not here. Fully controlled (filters in, onChange out).

import { useEffect, useRef, useState } from 'react'
import { derivePersonaKey } from '@/lib/pure/persona'
import type { Platform, Timeframe } from '@/lib/types'

export interface Filters {
  // §17.4: a subset of platforms; empty = all. Serializes to `platform=<comma list>`.
  platforms: Platform[]
  keywords: string[]
  authors: string[]
  minLikes: number
  minShares: number
  minXFactor: number
  timeframe: Timeframe
  dateFrom?: string
  dateTo?: string
  market?: string // '' / undefined = all markets; options land with the Layer 6 markets store
  sort: 'recent' | 'likes' | 'xfactor'
  groupByImage: boolean
  discoverTrends: boolean
  imageThreshold: number
  textThreshold: number
}

export interface AuthorOption {
  author_id: string
  author_name: string | null
  platform?: Platform // which platform this account posts on (drives the row's platform badge)
  avatar?: string | null
  isCore?: boolean // a creator you follow/scrape (vs. a keyword-discovered author)
  persona?: string | null // §17.3: the person this account belongs to (links accounts across platforms)
}

const PLATFORM_OPTIONS: { value: Platform; label: string }[] = [
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'twitter', label: 'Twitter' },
  { value: 'substack', label: 'Substack' },
]

const PLATFORM_LABEL: Record<Platform, string> = Object.fromEntries(
  PLATFORM_OPTIONS.map((o) => [o.value, o.label]),
) as Record<Platform, string>

/** The persona key an account groups under: an explicit persona when set, else one derived from the
 *  display name — so two accounts named "Noah West" link across platforms even with no persona set. */
function groupKeyFor(a: AuthorOption): string | null {
  return a.persona ?? derivePersonaKey(a.author_name ?? a.author_id)
}

/** Small platform badge shown on a creator row so you can tell LinkedIn from Substack at a glance. */
function PlatformBadge({ platform }: { platform?: Platform }): JSX.Element | null {
  if (!platform) return null
  return <span className={`filter-bar__creator-platform badge badge--platform badge--${platform}`}>{PLATFORM_LABEL[platform]}</span>
}

/** Title-case a normalized persona key ("lara acosta" → "Lara Acosta") for display. */
function personaLabel(persona: string, authors: AuthorOption[]): string {
  const named = authors.find((a) => a.author_name)?.author_name
  return named ?? persona.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Creator avatar: the profile photo when it loads, else a colored initial. LinkedIn photo URLs
 *  expire, so we always fall back gracefully instead of showing a broken image. */
function CreatorAvatar({ name, avatar }: { name: string; avatar?: string | null }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const label = (name || '?').trim()
  const initial = label.charAt(0).toUpperCase() || '?'
  if (avatar && !broken) {
    return (
      <img
        className="filter-bar__creator-avatar"
        src={avatar}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }
  const hue = [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span
      className="filter-bar__creator-avatar filter-bar__creator-avatar--fallback"
      style={{ background: `hsl(${hue} 55% 60%)` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

/** A numeric filter input that shows empty (with a "0" placeholder) instead of a literal 0 — so there's
 *  no stuck leading zero to delete. Keeps its own text state so decimals (e.g. "0.5") type cleanly, and
 *  emits a parsed number (empty → 0) to the parent. */
function NumberField({
  label,
  value,
  onChange,
  step,
  title,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  step?: number
  title?: string
}): JSX.Element {
  const [text, setText] = useState(value ? String(value) : '')
  // Re-sync when the value changes externally (e.g. filters reset), without clobbering live typing.
  useEffect(() => {
    if (Number(text || 0) !== value) setText(value ? String(value) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <label className="filter-bar__field" title={title}>
      {label}
      <input
        type="number"
        min={0}
        step={step}
        inputMode={step ? 'decimal' : 'numeric'}
        placeholder="0"
        value={text}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          onChange(raw === '' ? 0 : Number(raw))
        }}
      />
    </label>
  )
}

const TIMEFRAMES: Timeframe[] = ['all', '24h', '3d', 'week', 'month', '3months', 'custom']
const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  all: 'All time',
  '24h': 'Last 24 hours',
  '3d': 'Last 3 days',
  week: 'Last week',
  month: 'Last 30 days',
  '3months': 'Last 3 months',
  custom: 'Custom range',
}

export function DashboardFilterBar({
  filters,
  availableAuthors,
  onChange,
  onSearch,
}: {
  filters: Filters
  availableAuthors: AuthorOption[]
  onChange: (next: Filters) => void
  onSearch?: () => void
}) {
  const [draftKeyword, setDraftKeyword] = useState('')
  const [creatorQuery, setCreatorQuery] = useState('')
  const creatorSearchRef = useRef<HTMLInputElement>(null)
  const creatorsRef = useRef<HTMLDetailsElement>(null)
  const set = (patch: Partial<Filters>): void => onChange({ ...filters, ...patch })

  // A native <details> doesn't close on an outside click — wire that up (and Escape) ourselves.
  useEffect(() => {
    const el = creatorsRef.current
    if (!el) return
    const closeIfOutside = (e: Event): void => {
      if (el.open && !el.contains(e.target as Node)) el.open = false
    }
    const closeOnEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && el.open) el.open = false
    }
    document.addEventListener('mousedown', closeIfOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeIfOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  // Search-first: the dropdown is a type-to-find box, not a list of all 40k+ scraped authors. Nothing
  // is listed until you type; the empty box just shows the creators you've already picked so you can
  // review/unpick them. (An EMPTY authors list means "all creators" — no filter — so the request never
  // enumerates every id into the URL, which used to overflow it → HTTP 431.)
  const q = creatorQuery.trim().toLowerCase()
  const searching = q.length > 0
  const selected = new Set(filters.authors)
  const matchingAuthors = searching
    ? availableAuthors.filter((a) => (a.author_name ?? a.author_id).toLowerCase().includes(q))
    : []
  const RENDER_CAP = 150
  const shownAuthors = matchingAuthors.slice(0, RENDER_CAP)
  // Empty-box state: the accounts you've already selected, so your picks stay visible while you search.
  const selectedAuthors = availableAuthors.filter((a) => selected.has(a.author_id))

  // §17.3: group accounts by PERSON so you can select all of someone's accounts (across platforms) at
  // once. Grouping falls back to a name-derived key when no explicit persona is set, so two accounts
  // named "Noah West" still link. Only groups with >1 account are worth showing.
  const personaGroups = (() => {
    const byPersona = new Map<string, AuthorOption[]>()
    for (const a of matchingAuthors) {
      const key = groupKeyFor(a)
      if (!key) continue
      const arr = byPersona.get(key) ?? []
      arr.push(a)
      byPersona.set(key, arr)
    }
    return [...byPersona.entries()]
      .filter(([, members]) => members.length > 1)
      .map(([persona, members]) => ({
        persona,
        label: personaLabel(persona, members),
        ids: members.map((m) => m.author_id),
      }))
  })()

  const toggleAuthor = (authorId: string, on: boolean): void =>
    set({ authors: on ? [...filters.authors, authorId] : filters.authors.filter((x) => x !== authorId) })

  const renderAccountRow = (a: AuthorOption): JSX.Element => (
    <label key={a.author_id} className="filter-bar__creator">
      <input
        type="checkbox"
        checked={selected.has(a.author_id)}
        onChange={(e) => toggleAuthor(a.author_id, e.target.checked)}
      />
      <CreatorAvatar name={a.author_name ?? a.author_id} avatar={a.avatar} />
      <span className="filter-bar__creator-name">{a.author_name ?? a.author_id}</span>
      <PlatformBadge platform={a.platform} />
    </label>
  )

  const togglePerson = (ids: string[], on: boolean): void => {
    const others = filters.authors.filter((x) => !ids.includes(x))
    set({ authors: on ? [...others, ...ids] : others })
  }

  const togglePlatform = (p: Platform, on: boolean): void =>
    set({ platforms: on ? [...filters.platforms, p] : filters.platforms.filter((x) => x !== p) })

  const addKeyword = (): void => {
    const kw = draftKeyword.trim()
    if (kw && !filters.keywords.includes(kw)) set({ keywords: [...filters.keywords, kw] })
    setDraftKeyword('')
  }

  return (
    <div className="filter-bar">
      <div className="filter-bar__keywords">
        {filters.keywords.map((kw) => (
          <span key={kw} className="chip">
            {kw}
            <button
              type="button"
              aria-label={`remove ${kw}`}
              onClick={() => set({ keywords: filters.keywords.filter((k) => k !== kw) })}
            >
              ×
            </button>
          </span>
        ))}
        <label className="filter-bar__field">
          Add keyword
          <input
            placeholder="Keywords…"
            value={draftKeyword}
            onChange={(e) => setDraftKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addKeyword()
              }
            }}
          />
        </label>
      </div>

      <details
        ref={creatorsRef}
        className="filter-bar__field filter-bar__creators"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) creatorSearchRef.current?.focus()
        }}
      >
        <summary>
          Creators ({filters.authors.length === 0 ? 'All' : `${filters.authors.length} selected`})
        </summary>
        <div className="filter-bar__creators-panel">
          <div className="filter-bar__creators-actions">
            <input
              ref={creatorSearchRef}
              className="filter-bar__creators-search"
              placeholder="Find a creator by name…"
              value={creatorQuery}
              onChange={(e) => setCreatorQuery(e.target.value)}
            />
            <button type="button" onClick={() => set({ authors: [] })} disabled={filters.authors.length === 0}>
              Clear
            </button>
          </div>
          {availableAuthors.length === 0 && <span className="filter-bar__creators-empty">No creators yet</span>}

          {/* Empty box: show the accounts already picked (so they stay visible while you search) + a hint. */}
          {availableAuthors.length > 0 && !searching && (
            <>
              {selectedAuthors.length > 0 && (
                <div className="filter-bar__personas">
                  <span className="filter-bar__personas-title">Selected</span>
                  {selectedAuthors.map((a) => renderAccountRow(a))}
                </div>
              )}
              <span className="filter-bar__creators-empty">Type a name to find creators across platforms.</span>
            </>
          )}

          {searching && personaGroups.length > 0 && (
            <div className="filter-bar__personas">
              <span className="filter-bar__personas-title">People — all accounts</span>
              {personaGroups.map((g) => {
                const allSelected = g.ids.every((id) => selected.has(id))
                return (
                  <label key={g.persona} className="filter-bar__creator filter-bar__person">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${g.ids.length} accounts for ${g.label}`}
                      checked={allSelected}
                      onChange={(e) => togglePerson(g.ids, e.target.checked)}
                    />
                    <CreatorAvatar name={g.label} avatar={null} />
                    <span className="filter-bar__creator-name">
                      {g.label} <span className="filter-bar__person-count">· {g.ids.length} accounts</span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}

          {searching && shownAuthors.map((a) => renderAccountRow(a))}
          {searching && matchingAuthors.length === 0 && (
            <span className="filter-bar__creators-empty">No creators match “{creatorQuery.trim()}”.</span>
          )}
          {searching && matchingAuthors.length > shownAuthors.length && (
            <span className="filter-bar__creators-empty">
              +{matchingAuthors.length - shownAuthors.length} more — keep typing to narrow
            </span>
          )}
        </div>
      </details>

      <NumberField label="Min likes" title="minimum likes" value={filters.minLikes} onChange={(n) => set({ minLikes: n })} />
      <NumberField label="Min shares" title="minimum shares" value={filters.minShares} onChange={(n) => set({ minShares: n })} />
      <NumberField label="Min x-factor" title="minimum x-factor" step={0.1} value={filters.minXFactor} onChange={(n) => set({ minXFactor: n })} />

      <label className="filter-bar__field">
        Sort
        <select value={filters.sort} onChange={(e) => set({ sort: e.target.value as Filters['sort'] })}>
          <option value="recent">Newest</option>
          <option value="likes">Most liked</option>
          <option value="xfactor">Highest x-factor</option>
        </select>
      </label>

      <label className="filter-bar__field">
        Timeframe
        <select value={filters.timeframe} onChange={(e) => set({ timeframe: e.target.value as Timeframe })}>
          {TIMEFRAMES.map((t) => (
            <option key={t} value={t}>
              {TIMEFRAME_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {filters.timeframe === 'custom' && (
        <>
          <label className="filter-bar__field">
            From
            <input type="date" value={filters.dateFrom ?? ''} onChange={(e) => set({ dateFrom: e.target.value })} />
          </label>
          <label className="filter-bar__field">
            To
            <input type="date" value={filters.dateTo ?? ''} onChange={(e) => set({ dateTo: e.target.value })} />
          </label>
        </>
      )}

      <label className="filter-bar__field">
        Market
        {/* Options populate from the Layer 6 markets store; for now, all markets. */}
        <select value={filters.market ?? ''} onChange={(e) => set({ market: e.target.value })}>
          <option value="">All markets</option>
        </select>
      </label>

      <fieldset className="filter-bar__platforms">
        <legend>Platform</legend>
        {/* Toggle pills — any subset; none pressed = All (§17.4). One line, never wrapping. */}
        <div className="filter-bar__platform-list">
          {PLATFORM_OPTIONS.map(({ value, label }) => {
            const on = filters.platforms.includes(value)
            return (
              <button
                key={value}
                type="button"
                className={`filter-bar__platform badge--${value}`}
                aria-pressed={on}
                onClick={() => togglePlatform(value, !on)}
              >
                {label}
              </button>
            )
          })}
        </div>
      </fieldset>

      <button type="button" className="filter-bar__search" onClick={() => onSearch?.()}>
        Search
      </button>
    </div>
  )
}
