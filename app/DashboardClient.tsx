'use client'
// Layer 5 — DashboardClient (PRD §12 step 30, wireframe §11.5 Screen A): header (title, result
// count, grid/list toggle, Group-by-image / Discover-trends buttons), the search filter row, and the
// results (post grid vs image-group / content-cluster views). Scraping lives on Scrape Settings.

import { useCallback, useEffect, useState } from 'react'
import { DashboardFilterBar, type AuthorOption, type Filters } from '@/app/DashboardFilterBar'
import { PostCard, type PostCardPost } from '@/app/PostCard'

interface ImageGroup {
  postIds: string[]
  sharedDescription: string | null
  totalLikes: number
  totalShares: number
}
interface ContentCluster {
  postIds: string[]
  label: string | null
  totalLikes: number
  totalShares: number
}
interface PostsResponse {
  posts: PostCardPost[]
  total?: number
  availableAuthors: AuthorOption[]
  hasMore: boolean
  imageGroups?: ImageGroup[]
  contentClusters?: ContentCluster[]
}

export const DEFAULT_FILTERS: Filters = {
  platform: 'all',
  keywords: [],
  authors: [],
  minLikes: 0,
  minShares: 0,
  minXFactor: 0,
  timeframe: 'week',
  market: '',
  sort: 'recent',
  groupByImage: false,
  discoverTrends: false,
  imageThreshold: 0.8,
  textThreshold: 0.65,
}

export function toQuery(f: Filters): string {
  const p = new URLSearchParams()
  if (f.platform !== 'all') p.set('platform', f.platform)
  if (f.keywords.length) p.set('keywords', f.keywords.join(','))
  if (f.authors.length) p.set('authors', f.authors.join(','))
  if (f.minLikes) p.set('minLikes', String(f.minLikes))
  if (f.minShares) p.set('minShares', String(f.minShares))
  if (f.minXFactor) p.set('minXFactor', String(f.minXFactor))
  p.set('timeframe', f.timeframe)
  if (f.timeframe === 'custom') {
    if (f.dateFrom) p.set('dateFrom', f.dateFrom)
    if (f.dateTo) p.set('dateTo', f.dateTo)
  }
  if (f.market) p.set('market', f.market)
  p.set('sort', f.sort)
  if (f.groupByImage) {
    p.set('groupByImage', 'true')
    p.set('imageThreshold', String(f.imageThreshold))
  }
  if (f.discoverTrends) {
    p.set('discoverTrends', 'true')
    p.set('textThreshold', String(f.textThreshold))
  }
  return p.toString()
}

export function DashboardClient() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [data, setData] = useState<PostsResponse>({ posts: [], total: 0, availableAuthors: [], hasMore: false })

  const load = useCallback(async (): Promise<void> => {
    const res = await fetch(`/api/posts?${toQuery(filters)}`)
    setData((await res.json()) as PostsResponse)
  }, [filters])

  useEffect(() => {
    void load()
  }, [load])

  const total = data.total ?? data.posts.length
  const grouping = Boolean(data.imageGroups || data.contentClusters)

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <div>
          <h1>Search Posts</h1>
          <p className="dashboard__count">
            Showing {data.posts.length} of {total} matching posts
          </p>
        </div>
        <div className="dashboard__header-actions">
          <div className="dashboard__view" role="group" aria-label="view">
            <button type="button" aria-label="grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
              ▦
            </button>
            <button type="button" aria-label="list view" aria-pressed={view === 'list'} onClick={() => setView('list')}>
              ≣
            </button>
          </div>
          <button
            type="button"
            aria-pressed={filters.groupByImage}
            onClick={() => setFilters((f) => ({ ...f, groupByImage: !f.groupByImage, discoverTrends: false }))}
          >
            Group by image
          </button>
          <button
            type="button"
            aria-pressed={filters.discoverTrends}
            onClick={() => setFilters((f) => ({ ...f, discoverTrends: !f.discoverTrends, groupByImage: false }))}
          >
            Discover trends
          </button>
        </div>
      </header>

      <DashboardFilterBar filters={filters} availableAuthors={data.availableAuthors} onChange={setFilters} onSearch={load} />

      {data.imageGroups ? (
        <ul className="dashboard__groups">
          {data.imageGroups.map((g, i) => (
            <li key={i}>
              <strong>{g.sharedDescription ?? 'Similar images'}</strong> · {g.postIds.length} posts ·{' '}
              {g.totalLikes + g.totalShares} engagement
            </li>
          ))}
        </ul>
      ) : data.contentClusters ? (
        <ul className="dashboard__clusters">
          {data.contentClusters.map((c, i) => (
            <li key={i}>
              <strong>{c.label ?? 'Cluster'}</strong> · {c.postIds.length} posts ·{' '}
              {c.totalLikes + c.totalShares} engagement
            </li>
          ))}
        </ul>
      ) : (
        <div className={`dashboard__results dashboard__results--${grouping ? 'grid' : view}`}>
          {data.posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
        </div>
      )}
    </div>
  )
}
