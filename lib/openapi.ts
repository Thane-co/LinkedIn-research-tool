// Layer 3 — the self-description of the read-only agent API (PRD §20).
//
// ONE endpoint table drives both the human-readable manifest (GET /api/v1) and the OpenAPI document
// (GET /api/v1/openapi.json), so the two can never drift. Everything here is static data — no I/O,
// no secrets: the token is supplied by the caller and never appears in this module.

import {
  CANDIDATE_CAP,
  CONTENT_SIMILARITY_THRESHOLD,
  IMAGE_SIMILARITY_THRESHOLD,
  MIN_GROUP_SIZE,
} from '@/lib/config'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/db/posts.repo'
import { SORTS, TIMEFRAMES, VALID_PLATFORMS } from '@/lib/posts-query'

type ParamType = 'string' | 'integer' | 'number' | 'boolean'

export interface ApiParam {
  name: string
  type: ParamType
  description: string
  enum?: readonly string[]
  example?: string
}

export interface ApiEndpoint {
  path: string
  operationId: string
  summary: string
  params: readonly ApiParam[]
}

/** Filters shared by /posts and /authors — the same set the dashboard's filter bar drives. */
export const FILTER_PARAMS: readonly ApiParam[] = [
  {
    name: 'q',
    type: 'string',
    description:
      'Comma-separated substrings matched against post content (OR). Alias of `keywords`; both are combined.',
    example: 'ai agents,claude code',
  },
  { name: 'keywords', type: 'string', description: 'Same as `q`.', example: 'hiring' },
  {
    name: 'platform',
    type: 'string',
    description:
      'Comma-separated platform subset. Omit (or pass every platform) for no platform filter; unknown values are ignored.',
    enum: VALID_PLATFORMS,
    example: 'linkedin,substack',
  },
  {
    name: 'authors',
    type: 'string',
    description: 'Comma-separated author_id values (clean slugs/handles, from /api/v1/authors).',
    example: 'basiakubicka',
  },
  { name: 'market', type: 'string', description: 'Exact market bucket the post was scraped under.', example: 'ai' },
  { name: 'minLikes', type: 'integer', description: 'Only posts with at least this many likes.' },
  { name: 'minShares', type: 'integer', description: 'Only posts with at least this many shares/reposts.' },
  {
    name: 'minXFactor',
    type: 'number',
    description:
      'Only posts whose x_factor (weighted engagement ÷ that author’s 30-day baseline) is at least this. Posts with no baseline yet (x_factor null) are excluded.',
    example: '2',
  },
  {
    name: 'timeframe',
    type: 'string',
    description: 'Relative window on posted_at. `custom` uses dateFrom/dateTo. Default: all.',
    enum: TIMEFRAMES,
  },
  { name: 'dateFrom', type: 'string', description: 'ISO timestamp lower bound (timeframe=custom).' },
  { name: 'dateTo', type: 'string', description: 'ISO timestamp upper bound (timeframe=custom).' },
]

const PAGING_PARAMS: readonly ApiParam[] = [
  { name: 'sort', type: 'string', description: 'Ordering. Default: recent (posted_at desc).', enum: SORTS },
  { name: 'page', type: 'integer', description: '1-based page number. Default: 1.' },
  {
    name: 'pageSize',
    type: 'integer',
    description: `Rows per page. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}. A non-numeric value falls back to the default.`,
  },
]

const GROUPING_PARAMS: readonly ApiParam[] = [
  {
    name: 'groupByImage',
    type: 'boolean',
    description: `Set true to cluster the filtered posts by visual similarity of their image. Returns imageGroups instead of pagination, over at most ${CANDIDATE_CAP} most-liked candidates.`,
  },
  {
    name: 'discoverTrends',
    type: 'boolean',
    description: `Set true to cluster the filtered posts by content similarity. Returns contentClusters instead of pagination, over at most ${CANDIDATE_CAP} most-liked candidates.`,
  },
  {
    name: 'imageThreshold',
    type: 'number',
    description: `Cosine cutoff for groupByImage. Default ${IMAGE_SIMILARITY_THRESHOLD}.`,
  },
  {
    name: 'textThreshold',
    type: 'number',
    description: `Cosine cutoff for discoverTrends. Default ${CONTENT_SIMILARITY_THRESHOLD}.`,
  },
]

export const READONLY_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    path: '/api/v1',
    operationId: 'getManifest',
    summary: 'This manifest: every endpoint, parameter, and enum value the API accepts.',
    params: [],
  },
  {
    path: '/api/v1/openapi.json',
    operationId: 'getOpenApi',
    summary: 'The same surface as an OpenAPI 3.1 document.',
    params: [],
  },
  {
    path: '/api/v1/stats',
    operationId: 'getStats',
    summary:
      'Corpus summary: posts per platform and market, date coverage, enrichment counts, creator count. Read this first to know what is searchable.',
    params: [],
  },
  {
    path: '/api/v1/posts',
    operationId: 'searchPosts',
    summary:
      'Search stored posts. Paginated by default; set groupByImage or discoverTrends to get clusters instead.',
    params: [...FILTER_PARAMS, ...PAGING_PARAMS, ...GROUPING_PARAMS],
  },
  {
    path: '/api/v1/posts/{id}',
    operationId: 'getPost',
    summary: 'One stored post by id (including its transcript, when it has one).',
    params: [],
  },
  {
    path: '/api/v1/authors',
    operationId: 'listAuthors',
    summary:
      'Distinct authors present in the corpus under the given filters, with the author_id values to feed back into `authors`.',
    params: FILTER_PARAMS,
  },
  {
    path: '/api/v1/creators',
    operationId: 'listCreators',
    summary: 'The tracked creator list (the accounts scraped on purpose), with tiers, tags, and personas.',
    params: [
      { name: 'platform', type: 'string', description: 'Filter by platform.', enum: VALID_PLATFORMS },
      { name: 'tier', type: 'string', description: 'Filter by tier.', enum: ['core', 'watch'] as const },
      { name: 'tag', type: 'string', description: 'Filter by a single tag.' },
    ],
  },
  {
    path: '/api/v1/keywords',
    operationId: 'listKeywords',
    summary: 'Saved keyword sets, grouped by market.',
    params: [],
  },
  {
    path: '/api/v1/profiles',
    operationId: 'listProfiles',
    summary: 'LinkedIn profiles scraped so far (headline, about, follower count, experience).',
    params: [],
  },
]

/** The agent-facing manifest: what this API is, how to authenticate, and every endpoint. */
export function buildManifest(): Record<string, unknown> {
  return {
    name: 'Viral Post Research Tool — read-only API',
    version: '1',
    readOnly: true,
    description:
      'Read-only access to the local research corpus: search stored posts with the full filter set, group them by image, cluster them by content, and list creators, authors, keywords, and profiles. This API cannot scrape, enrich, write, or read API keys — only GET handlers exist.',
    auth: {
      type: 'bearer',
      header: 'Authorization: Bearer <token>',
      alternativeHeader: 'x-api-key: <token>',
      note: 'The token is never accepted as a query parameter. 401 = wrong/missing token; 503 = no token configured on the server.',
    },
    cannotDo: [
      'scrape or trigger any Apify actor',
      'transcribe video',
      'read or change settings, API keys, or actor ids',
      'create, edit, or delete posts, creators, keywords, or profiles',
    ],
    enums: {
      platform: VALID_PLATFORMS,
      timeframe: TIMEFRAMES,
      sort: SORTS,
      tier: ['core', 'watch'],
    },
    defaults: {
      pageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
      imageThreshold: IMAGE_SIMILARITY_THRESHOLD,
      textThreshold: CONTENT_SIMILARITY_THRESHOLD,
      minGroupSize: MIN_GROUP_SIZE,
      clusteringCandidateCap: CANDIDATE_CAP,
    },
    notes: [
      'x_factor = a post’s weighted engagement (likes·1 + comments·3 + shares·5) ÷ the same author’s mean weighted engagement over the prior 30 days. It needs ≥3 prior posts, so it is null on new authors.',
      'Grouping modes return every candidate in `posts` plus the groups as id lists — resolve members by id.',
      'Image and vector data are never serialized; `media` carries the renderable urls.',
    ],
    endpoints: READONLY_ENDPOINTS.map((e) => ({
      method: 'GET',
      path: e.path,
      summary: e.summary,
      params: e.params,
    })),
  }
}

function schemaFor(p: ApiParam): Record<string, unknown> {
  return p.enum ? { type: 'string', enum: [...p.enum] } : { type: p.type }
}

/** The same surface as an OpenAPI 3.1 document, for agents that consume specs directly. */
export function buildOpenApiSpec(origin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {}
  for (const e of READONLY_ENDPOINTS) {
    const pathParams = e.path.includes('{id}')
      ? [{ name: 'id', in: 'path', required: true, description: 'Post id.', schema: { type: 'string' } }]
      : []
    paths[e.path] = {
      get: {
        operationId: e.operationId,
        summary: e.summary,
        parameters: [
          ...pathParams,
          ...e.params.map((p) => ({
            name: p.name,
            in: 'query',
            required: false,
            description: p.description,
            schema: schemaFor(p),
            ...(p.example ? { example: p.example } : {}),
          })),
        ],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
          '401': { description: 'Missing or incorrect read-only token.' },
          '404': { description: 'Not found.' },
          '503': { description: 'No read-only token configured on the server.' },
        },
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Viral Post Research Tool — read-only API',
      version: '1.0.0',
      description: buildManifest().description,
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths,
  }
}
