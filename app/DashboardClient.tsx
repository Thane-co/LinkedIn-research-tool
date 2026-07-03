'use client'
// Layer 5 — DashboardClient (PRD §12 step 30, wireframe §11.5 Screen A): header (title, result
// count, Group-by-image / Discover-trends buttons), the search filter row, and the results (post
// grid vs image-group / content-cluster views). Scraping lives on Scrape Settings.

import { useCallback, useEffect, useRef, useState } from 'react'
import { DashboardFilterBar, type AuthorOption, type Filters } from '@/app/DashboardFilterBar'
import { PostCard, type PostCardPost } from '@/app/PostCard'
import { apiFetch } from '@/lib/api-client'

interface ImageGroup {
  postIds: string[]
  sharedDescription: string | null
  similarity: number
  totalLikes: number
  totalShares: number
}
interface ContentCluster {
  postIds: string[]
  label: string | null
  similarity: number
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
  timeframe: 'all', // landing view: latest posts across every creator, no date filter
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

/** A collapsible group/cluster: summary line → expands to the member post cards. */
function GroupPanel({
  title,
  postIds,
  similarity,
  engagement,
  postById,
}: {
  title: string
  postIds: string[]
  similarity: number
  engagement: number
  postById: Map<string, PostCardPost>
}) {
  const members = postIds.map((id) => postById.get(id)).filter((p): p is PostCardPost => Boolean(p))
  return (
    <details className="group-panel">
      <summary>
        <strong>{title}</strong> · {postIds.length} posts ·{' '}
        <span className="dashboard__sim">{Math.round(similarity * 100)}% similar</span> · {engagement} engagement
      </summary>
      <div className="dashboard__results dashboard__results--grid group-panel__posts">
        {members.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
      </div>
    </details>
  )
}

export function DashboardClient() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [data, setData] = useState<PostsResponse>({ posts: [], total: 0, availableAuthors: [], hasMore: false })
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  // Load a page. Page 1 replaces the results; later pages append (Load more). Filters go in the query
  // string, but the author include-list stays small (empty = all), so the URL never overflows.
  const load = useCallback(
    async (pageToLoad: number): Promise<void> => {
      try {
        setError(null)
        setLoading(true)
        const res = await apiFetch<PostsResponse>(`/api/posts?${toQuery(filters)}&page=${pageToLoad}`)
        setData((prev) => (pageToLoad > 1 ? { ...res, posts: [...prev.posts, ...res.posts] } : res))
        setPage(pageToLoad)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load posts')
      } finally {
        setLoading(false)
      }
    },
    [filters],
  )

  // Any filter change resets to the first page.
  useEffect(() => {
    void load(1)
  }, [load])

  // Infinite scroll: auto-load the next page when the sentinel nears the viewport. We only observe
  // while there's more to load and no request is in flight, so pages never double-fire.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !data.hasMore || loading) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void load(page + 1)
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [data.hasMore, loading, page, load])

  const total = data.total ?? data.posts.length
  const postById = new Map(data.posts.map((p) => [p.id, p]))

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
          <button
            type="button"
            aria-pressed={filters.groupByImage}
            onClick={() => setFilters((f) => ({ ...f, groupByImage: !f.groupByImage, discoverTrends: false }))}
          >
            Group by image
          </button>
          {filters.groupByImage && (
            <label className="dashboard__threshold" aria-label="image similarity threshold">
              Similarity {Math.round(filters.imageThreshold * 100)}%
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.01}
                value={filters.imageThreshold}
                onChange={(e) => setFilters((f) => ({ ...f, imageThreshold: Number(e.target.value) }))}
              />
            </label>
          )}
          <button
            type="button"
            aria-pressed={filters.discoverTrends}
            onClick={() => setFilters((f) => ({ ...f, discoverTrends: !f.discoverTrends, groupByImage: false }))}
          >
            Discover trends
          </button>
          {filters.discoverTrends && (
            <label className="dashboard__threshold" aria-label="content similarity threshold">
              Similarity {Math.round(filters.textThreshold * 100)}%
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.01}
                value={filters.textThreshold}
                onChange={(e) => setFilters((f) => ({ ...f, textThreshold: Number(e.target.value) }))}
              />
            </label>
          )}
        </div>
      </header>

      <DashboardFilterBar filters={filters} availableAuthors={data.availableAuthors} onChange={setFilters} onSearch={() => void load(1)} />

      {error && (
        <p className="dashboard__error" role="alert">
          Couldn’t load posts: {error}
        </p>
      )}

      {data.imageGroups ? (
        data.imageGroups.length === 0 ? (
          <p className="dashboard__empty">
            No image groups at {Math.round(filters.imageThreshold * 100)}% similarity — lower the slider,
            or try Discover trends for topical grouping.
          </p>
        ) : (
          <div className="dashboard__groups">
            {data.imageGroups.map((g, i) => (
              <GroupPanel
                key={i}
                title={g.sharedDescription ?? 'Similar images'}
                postIds={g.postIds}
                similarity={g.similarity}
                engagement={g.totalLikes + g.totalShares}
                postById={postById}
              />
            ))}
          </div>
        )
      ) : data.contentClusters ? (
        data.contentClusters.length === 0 ? (
          <p className="dashboard__empty">
            No trends at {Math.round(filters.textThreshold * 100)}% similarity — lower the slider.
          </p>
        ) : (
          <div className="dashboard__clusters">
            {data.contentClusters.map((c, i) => (
              <GroupPanel
                key={i}
                title={c.label ?? 'Cluster'}
                postIds={c.postIds}
                similarity={c.similarity}
                engagement={c.totalLikes + c.totalShares}
                postById={postById}
              />
            ))}
          </div>
        )
      ) : (
        <>
          <div className="dashboard__results dashboard__results--grid">
            {data.posts.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </div>
          {data.hasMore && (
            <>
              <div ref={sentinelRef} aria-hidden="true" className="dashboard__sentinel" />
              <div className="dashboard__loadmore">
                <button type="button" disabled={loading} onClick={() => void load(page + 1)}>
                  {loading ? 'Loading…' : `Load more (${data.posts.length} of ${total})`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
