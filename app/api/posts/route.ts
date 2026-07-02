// Layer 4 — GET /api/posts (PRD §11.1, §12 step 24). Thin: parse params -> repo/pure -> json.
// Paginated mode by default; grouping mode when groupByImage or discoverTrends is true (cap 400).

import { NextResponse } from 'next/server'
import { IMAGE_SIMILARITY_THRESHOLD, CONTENT_SIMILARITY_THRESHOLD } from '@/lib/config'
import {
  getAvailableAuthors,
  getCandidatesForClustering,
  searchPosts,
  type PostFilters,
} from '@/lib/db/posts.repo'
import { findContentClusters } from '@/lib/pure/content-clusters'
import { findSimilarImageGroups } from '@/lib/pure/image-groups'
import type { PostMedia, PostRow, PostWithMedia, SortMode, Timeframe } from '@/lib/types'

// Reads the live DB — never statically prerender/cache.
export const dynamic = 'force-dynamic'

/** Parse the shared filter set from the query string (PRD §11.1). */
function parseFilters(sp: URLSearchParams): PostFilters {
  const num = (key: string): number | undefined => {
    const raw = sp.get(key)
    return raw === null || raw === '' ? undefined : Number(raw)
  }
  const list = (key: string): string[] | undefined => {
    const parts = sp.get(key)?.split(',').map((s) => s.trim()).filter(Boolean)
    return parts && parts.length > 0 ? parts : undefined
  }
  return {
    platform: (sp.get('platform') as PostFilters['platform']) ?? undefined,
    keywords: list('keywords'),
    authors: list('authors'),
    minLikes: num('minLikes'),
    minShares: num('minShares'),
    minXFactor: num('minXFactor'),
    timeframe: (sp.get('timeframe') as Timeframe | null) ?? undefined,
    dateFrom: sp.get('dateFrom') ?? undefined,
    dateTo: sp.get('dateTo') ?? undefined,
    market: sp.get('market') || undefined,
    sort: (sp.get('sort') as SortMode | null) ?? undefined,
    page: num('page'),
    pageSize: num('pageSize'),
  }
}

/** Strip BLOBs + raw_data; parse the `media` JSON so the client gets a structured object. */
function serializePost(row: PostRow): Omit<PostRow, 'embedding' | 'image_embedding' | 'raw_data' | 'media'> & {
  media: PostMedia | null
} {
  const { embedding: _e, image_embedding: _i, raw_data: _r, media, ...rest } = row
  let parsed: PostMedia | null = null
  if (media) {
    try {
      parsed = JSON.parse(media) as PostMedia
    } catch {
      parsed = null
    }
  }
  return { ...rest, media: parsed }
}

/** Candidate post minus its heavy vectors, optionally annotated with its image-group size. */
function lightCandidate(p: PostWithMedia, imageGroupSize?: number): Record<string, unknown> {
  const { textEmbedding: _t, imageEmbedding: _i, ...rest } = p
  return imageGroupSize === undefined ? rest : { ...rest, imageGroupSize }
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams
  const filters = parseFilters(sp)
  const groupByImage = sp.get('groupByImage') === 'true'
  const discoverTrends = sp.get('discoverTrends') === 'true'
  const availableAuthors = getAvailableAuthors(filters)

  // --- Grouping mode: on-demand clustering over <=400 filtered candidates (PRD §9, §11.1) -------
  if (groupByImage || discoverTrends) {
    const imageThreshold = sp.get('imageThreshold') ? Number(sp.get('imageThreshold')) : IMAGE_SIMILARITY_THRESHOLD
    const textThreshold = sp.get('textThreshold') ? Number(sp.get('textThreshold')) : CONTENT_SIMILARITY_THRESHOLD

    if (groupByImage) {
      const candidates = getCandidatesForClustering(filters, true).filter((c) => c.imageEmbedding !== null)
      const imageGroups = findSimilarImageGroups(
        candidates.map((c) => ({
          id: c.id,
          imageEmbedding: c.imageEmbedding!,
          image_description: c.image_description,
          content: c.content,
          likes: c.likes,
          shares: c.shares,
        })),
        imageThreshold,
      )
      const sizeById = new Map<string, number>()
      for (const g of imageGroups) for (const id of g.postIds) sizeById.set(id, g.postIds.length)
      return NextResponse.json({
        posts: candidates.map((c) => lightCandidate(c, sizeById.get(c.id) ?? 1)),
        imageGroups,
        hasMore: false,
        availableAuthors,
      })
    }

    // discoverTrends
    const candidates = getCandidatesForClustering(filters, false).filter((c) => c.textEmbedding !== null)
    const contentClusters = findContentClusters(
      candidates.map((c) => ({
        id: c.id,
        content: c.content,
        textEmbedding: c.textEmbedding!,
        imageEmbedding: c.imageEmbedding,
        likes: c.likes,
        shares: c.shares,
      })),
      textThreshold,
    )
    return NextResponse.json({
      posts: candidates.map((c) => lightCandidate(c)),
      contentClusters,
      hasMore: false,
      availableAuthors,
    })
  }

  // --- Paginated mode (default) -----------------------------------------------------------------
  const { posts, total, page, pageSize, hasMore } = searchPosts(filters)
  return NextResponse.json({
    posts: posts.map(serializePost),
    total,
    page,
    pageSize,
    hasMore,
    availableAuthors,
  })
}
