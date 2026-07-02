'use client'
// Layer 5 — DashboardFilterBar (PRD §12 step 28, wireframe §11.5 Screen A): a single search row —
// keyword chips, creator dropdown (count), ♥ minLikes / ↗ minShares / ✕ minXFactor, sort, timeframe
// (+ custom range), market, platform, Search. Group-by-image / Discover-trends live in the header
// (DashboardClient), not here. Fully controlled (filters in, onChange out).

import { useState } from 'react'
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
}

const TIMEFRAMES: Timeframe[] = ['24h', '3d', 'week', 'month', '3months', 'custom']

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
  const set = (patch: Partial<Filters>): void => onChange({ ...filters, ...patch })

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

      <label className="filter-bar__field">
        Creators ({filters.authors.length}/{availableAuthors.length})
        <select
          multiple
          value={filters.authors}
          onChange={(e) => set({ authors: Array.from(e.target.selectedOptions, (o) => o.value) })}
        >
          {availableAuthors.map((a) => (
            <option key={a.author_id} value={a.author_id}>
              {a.author_name ?? a.author_id}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-bar__field" title="minimum likes">
        Min likes
        <input type="number" min={0} value={filters.minLikes} onChange={(e) => set({ minLikes: Number(e.target.value) })} />
      </label>
      <label className="filter-bar__field" title="minimum shares">
        Min shares
        <input type="number" min={0} value={filters.minShares} onChange={(e) => set({ minShares: Number(e.target.value) })} />
      </label>
      <label className="filter-bar__field" title="minimum x-factor">
        Min x-factor
        <input type="number" min={0} step={0.1} value={filters.minXFactor} onChange={(e) => set({ minXFactor: Number(e.target.value) })} />
      </label>

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
              {t}
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
