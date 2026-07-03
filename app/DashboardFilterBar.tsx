'use client'
// Layer 5 — DashboardFilterBar (PRD §12 step 28, wireframe §11.5 Screen A): a single search row —
// keyword chips, creator dropdown (count), ♥ minLikes / ↗ minShares / ✕ minXFactor, sort, timeframe
// (+ custom range), market, platform, Search. Group-by-image / Discover-trends live in the header
// (DashboardClient), not here. Fully controlled (filters in, onChange out).

import { useEffect, useState } from 'react'
import type { Timeframe } from '@/lib/types'

export interface Filters {
  platform: 'all' | 'linkedin' | 'twitter'
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
  avatar?: string | null
  isCore?: boolean // a creator you follow/scrape (vs. a keyword-discovered author)
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
  const set = (patch: Partial<Filters>): void => onChange({ ...filters, ...patch })

  // With the include-list model, an EMPTY authors list means "all creators" (no filter). So the
  // dropdown never needs to enumerate every id into the request (which overflowed the URL → HTTP 431).
  const q = creatorQuery.trim().toLowerCase()
  const matchingAuthors =
    q.length > 0
      ? availableAuthors.filter((a) => (a.author_name ?? a.author_id).toLowerCase().includes(q))
      : availableAuthors
  const RENDER_CAP = 150
  const shownAuthors = matchingAuthors.slice(0, RENDER_CAP)
  const selected = new Set(filters.authors)
  const coreAuthorIds = availableAuthors.filter((a) => a.isCore).map((a) => a.author_id)

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

      <details className="filter-bar__field filter-bar__creators">
        <summary>
          Creators ({filters.authors.length === 0 ? 'All' : `${filters.authors.length} of ${availableAuthors.length}`})
        </summary>
        <div className="filter-bar__creators-panel">
          <div className="filter-bar__creators-actions">
            <button type="button" onClick={() => set({ authors: [] })} disabled={filters.authors.length === 0}>
              Show all
            </button>
            <button
              type="button"
              onClick={() => set({ authors: coreAuthorIds })}
              disabled={coreAuthorIds.length === 0}
              title="Select only the creators you follow/scrape"
            >
              Core creators{coreAuthorIds.length > 0 ? ` (${coreAuthorIds.length})` : ''}
            </button>
            <input
              className="filter-bar__creators-search"
              placeholder="Filter creators…"
              value={creatorQuery}
              onChange={(e) => setCreatorQuery(e.target.value)}
            />
          </div>
          {availableAuthors.length === 0 && <span className="filter-bar__creators-empty">No creators yet</span>}
          {shownAuthors.map((a) => (
            <label key={a.author_id} className="filter-bar__creator">
              <input
                type="checkbox"
                checked={selected.has(a.author_id)}
                onChange={(e) =>
                  set({
                    authors: e.target.checked
                      ? [...filters.authors, a.author_id]
                      : filters.authors.filter((x) => x !== a.author_id),
                  })
                }
              />
              <CreatorAvatar name={a.author_name ?? a.author_id} avatar={a.avatar} />
              <span className="filter-bar__creator-name">{a.author_name ?? a.author_id}</span>
            </label>
          ))}
          {matchingAuthors.length > shownAuthors.length && (
            <span className="filter-bar__creators-empty">
              +{matchingAuthors.length - shownAuthors.length} more — type to filter
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

      <label className="filter-bar__field">
        Platform
        <select value={filters.platform} onChange={(e) => set({ platform: e.target.value as Filters['platform'] })}>
          <option value="all">All</option>
          <option value="linkedin">LinkedIn</option>
          <option value="twitter">Twitter</option>
        </select>
      </label>

      <button type="button" className="filter-bar__search" onClick={() => onSearch?.()}>
        Search
      </button>
    </div>
  )
}
