// Layer 4 — GET /api/posts (PRD §11.1, §12 step 24). Thin: parse params -> repo/pure -> json.
// Paginated mode by default; grouping mode when groupByImage or discoverTrends is true (cap 400).

import { NextResponse } from 'next/server'
import { IMAGE_SIMILARITY_THRESHOLD, CONTENT_SIMILARITY_THRESHOLD } from '@/lib/config'
import {
  getAvailableAuthors,
  getCandidatesForClustering,
  searchPosts,
  type ClusteringCandidate,
  type PostFilters,
} from '@/lib/db/posts.repo'
import { findContentClusters } from '@/lib/pure/content-clusters'
import { findSimilarImageGroups } from '@/lib/pure/image-groups'
import { isPostMedia } from '@/lib/pure/media'
import type { PostMedia, PostRow, SortMode, Timeframe } from '@/lib/types'

// Reads the live DB — never statically prerender/cache.
export const dynamic = 'force-dynamic'

const PLATFORMS = ['all', 'linkedin', 'twitter'] as const
const TIMEFRAMES: readonly Timeframe[] = ['all', '24h', '3d', 'week', 'month', '3months', 'custom']
const SORTS: readonly SortMode[] = ['recent', 'likes', 'xfactor']

/** Return `raw` only if it's one of `allowed`, else undefined — so an unknown enum param is ignored,
 *  not blindly trusted. An invalid `timeframe` would otherwise crash the date math; a bad `platform`
 *  would silently filter out every row. */
function oneOf<T extends string>(allowed: readonly T[], raw: string | null): T | undefined {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}

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
    platform: oneOf(PLATFORMS, sp.get('platform')),
    keywords: list('keywords'),
    authors: list('authors'),
    minLikes: num('minLikes'),
    minShares: num('minShares'),
    minXFactor: num('minXFactor'),
    timeframe: oneOf(TIMEFRAMES, sp.get('timeframe')),
    dateFrom: sp.get('dateFrom') ?? undefined,
    dateTo: sp.get('dateTo') ?? undefined,
    market: sp.get('market') || undefined,
    sort: oneOf(SORTS, sp.get('sort')),
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
      const candidate: unknown = JSON.parse(media)
      parsed = isPostMedia(candidate) ? candidate : null
    } catch {
      parsed = null
    }
  }
  return { ...rest, media: parsed }
}

/** A clustering candidate serialized as a full renderable post (drop the decoded vectors first) — so
 *  the UI can render a group's members by looking their ids up in `posts`. */
function serializeCandidate(c: ClusteringCandidate): ReturnType<typeof serializePost> {
  const { textEmbedding: _t, imageEmbedding: _i, ...row } = c
  return serializePost(row)
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
      return NextResponse.json({
        posts: candidates.map((c) => serializeCandidate(c)),
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
      posts: candidates.map((c) => serializeCandidate(c)),
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
