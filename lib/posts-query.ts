// Layer 3 — the shared post-search surface (PRD §11.1, §20). Parses the query string, runs the
// paginated or grouping query, and serializes rows for transport. Lives here (not in a route) so the
// dashboard route and the read-only agent API answer with the SAME filters and the SAME shape —
// one implementation, no drift.

import { IMAGE_SIMILARITY_THRESHOLD, CONTENT_SIMILARITY_THRESHOLD } from '@/lib/config'
import {
  getAvailableAuthors,
  getCandidatesForClustering,
  searchPosts,
  type AvailableAuthor,
  type ClusteringCandidate,
  type PostFilters,
} from '@/lib/db/posts.repo'
import { findContentClusters } from '@/lib/pure/content-clusters'
import { findSimilarImageGroups } from '@/lib/pure/image-groups'
import { isPostMedia } from '@/lib/pure/media'
import type {
  ContentCluster,
  ImageGroup,
  Platform,
  PostMedia,
  PostRow,
  SortMode,
  Timeframe,
} from '@/lib/types'

export const VALID_PLATFORMS: readonly Platform[] = ['linkedin', 'twitter', 'substack', 'instagram']
export const TIMEFRAMES: readonly Timeframe[] = ['all', '24h', '3d', 'week', 'month', '3months', 'custom']
export const SORTS: readonly SortMode[] = ['recent', 'likes', 'xfactor']

/** A post as it goes over the wire: vectors and the raw scraped payload are dropped, `media` parsed. */
export type SerializedPost = Omit<PostRow, 'embedding' | 'image_embedding' | 'raw_data' | 'media'> & {
  media: PostMedia | null
}

export interface PostsResponse {
  posts: SerializedPost[]
  availableAuthors: AvailableAuthor[]
  hasMore: boolean
  total?: number
  page?: number
  pageSize?: number
  imageGroups?: ImageGroup[]
  contentClusters?: ContentCluster[]
  /** Present only when a param was ignored — see collectFilterWarnings. */
  warnings?: string[]
}

/** Return `raw` only if it's one of `allowed`, else undefined — so an unknown enum param is ignored,
 *  not blindly trusted. An invalid `timeframe` would otherwise crash the date math. */
function oneOf<T extends string>(allowed: readonly T[], raw: string | null): T | undefined {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}

/** Parse the `platform` param as a comma-separated subset (§17.4). 'all', empty, unknown-only, or the
 *  full set → undefined (no platform filter). Unknown tokens are dropped, not trusted. */
function parsePlatforms(raw: string | null): Platform[] | undefined {
  if (!raw) return undefined
  const tokens = raw.split(',').map((s) => s.trim().toLowerCase())
  const valid = [...new Set(tokens.filter((t): t is Platform => (VALID_PLATFORMS as readonly string[]).includes(t)))]
  return valid.length === 0 || valid.length === VALID_PLATFORMS.length ? undefined : valid
}

/** Parse the shared filter set from the query string (PRD §11.1). */
export function parsePostFilters(sp: URLSearchParams): PostFilters {
  // A non-numeric value is DROPPED, not passed through as NaN: NaN survives the repo's
  // Math.min/Math.max clamp, binds to SQLite as NULL, and `LIMIT NULL` means no limit at all.
  const num = (key: string): number | undefined => {
    const raw = sp.get(key)
    if (raw === null || raw === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  const list = (key: string): string[] => sp.get(key)?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  // `q` is an alias for `keywords` (both are OR'd content LIKE terms) — agents reach for `q` first.
  const keywords = [...list('keywords'), ...list('q')]
  const dateFrom = sp.get('dateFrom') || undefined
  const dateTo = sp.get('dateTo') || undefined
  // The repo only applies dateFrom/dateTo under timeframe='custom'. A caller that sends a date range
  // and no timeframe means the range, so infer 'custom' rather than silently returning all time.
  const timeframe = oneOf(TIMEFRAMES, sp.get('timeframe')) ?? (dateFrom || dateTo ? 'custom' : undefined)
  return {
    platforms: parsePlatforms(sp.get('platform')),
    keywords: keywords.length > 0 ? keywords : undefined,
    authors: list('authors').length > 0 ? list('authors') : undefined,
    minLikes: num('minLikes'),
    minShares: num('minShares'),
    minXFactor: num('minXFactor'),
    timeframe,
    dateFrom,
    dateTo,
    market: sp.get('market') || undefined,
    sort: oneOf(SORTS, sp.get('sort')),
    page: num('page'),
    pageSize: num('pageSize'),
  }
}

/** A clustering threshold: the given value when it's a real number, else the configured default.
 *  A typo'd threshold would otherwise become NaN, making every `>= threshold` test false and
 *  returning zero groups with a 200 — an empty answer that looks like a real one. */
function threshold(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/**
 * Params that were ignored because they weren't understood. Filters here fail OPEN (an unknown value
 * is dropped, not rejected), which is right for the dashboard but dangerous for an agent: a typo'd
 * `timeframe` silently widens the result set to all time. Reporting them lets a caller tell a real
 * answer from an accidentally-broad one.
 */
export function collectFilterWarnings(sp: URLSearchParams): string[] {
  const warnings: string[] = []
  const enumParam = <T extends string>(key: string, allowed: readonly T[]): void => {
    const raw = sp.get(key)
    if (raw !== null && raw !== '' && !(allowed as readonly string[]).includes(raw)) {
      warnings.push(`Ignored unknown ${key}='${raw}'. Expected one of: ${allowed.join(', ')}.`)
    }
  }
  enumParam('timeframe', TIMEFRAMES)
  enumParam('sort', SORTS)

  const platformRaw = sp.get('platform')
  if (platformRaw) {
    const unknown = platformRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '' && !(VALID_PLATFORMS as readonly string[]).includes(t.toLowerCase()))
    if (unknown.length > 0) {
      warnings.push(`Ignored unknown platform(s): ${unknown.join(', ')}. Expected: ${VALID_PLATFORMS.join(', ')}.`)
    }
  }

  for (const key of ['minLikes', 'minShares', 'minXFactor', 'page', 'pageSize', 'imageThreshold', 'textThreshold']) {
    const raw = sp.get(key)
    if (raw !== null && raw !== '' && !Number.isFinite(Number(raw))) {
      warnings.push(`Ignored non-numeric ${key}='${raw}'.`)
    }
  }

  if (sp.get('timeframe') && sp.get('timeframe') !== 'custom' && (sp.get('dateFrom') || sp.get('dateTo'))) {
    warnings.push(`dateFrom/dateTo are only applied with timeframe=custom; timeframe='${sp.get('timeframe')}' took precedence.`)
  }
  return warnings
}

/** Strip BLOBs + raw_data; parse the `media` JSON so the client gets a structured object. */
export function serializePost(row: PostRow): SerializedPost {
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
 *  a caller can render a group's members by looking their ids up in `posts`. */
function serializeCandidate(c: ClusteringCandidate): SerializedPost {
  const { textEmbedding: _t, imageEmbedding: _i, ...row } = c
  return serializePost(row)
}

/**
 * Run the post query described by `sp`: grouping mode when `groupByImage` or `discoverTrends` is
 * set (on-demand clustering over ≤CANDIDATE_CAP filtered candidates, PRD §9), paginated otherwise.
 */
export function runPostsQuery(sp: URLSearchParams): PostsResponse {
  const filters = parsePostFilters(sp)
  const groupByImage = sp.get('groupByImage') === 'true'
  const discoverTrends = sp.get('discoverTrends') === 'true'
  const availableAuthors = getAvailableAuthors(filters)
  const found = collectFilterWarnings(sp)
  const warnings = found.length > 0 ? { warnings: found } : {}

  if (groupByImage) {
    const imageThreshold = threshold(sp.get('imageThreshold'), IMAGE_SIMILARITY_THRESHOLD)
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
    return { posts: candidates.map(serializeCandidate), imageGroups, hasMore: false, availableAuthors, ...warnings }
  }

  if (discoverTrends) {
    const textThreshold = threshold(sp.get('textThreshold'), CONTENT_SIMILARITY_THRESHOLD)
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
    return { posts: candidates.map(serializeCandidate), contentClusters, hasMore: false, availableAuthors, ...warnings }
  }

  const { posts, total, page, pageSize, hasMore } = searchPosts(filters)
  return { posts: posts.map(serializePost), total, page, pageSize, hasMore, availableAuthors, ...warnings }
}

/** Distinct authors matching the current filters — the creator-filter dropdown, and the agent API's
 *  "who is in this corpus" lookup. */
export function listAuthors(sp: URLSearchParams): AvailableAuthor[] {
  return getAvailableAuthors(parsePostFilters(sp))
}
