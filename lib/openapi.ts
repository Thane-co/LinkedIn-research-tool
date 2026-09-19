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
import { MATCH_MODES, SORTS, TIMEFRAMES, VALID_PLATFORMS } from '@/lib/posts-query'

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
      'Comma-separated terms, full-text searched over post content. Matching is by WORD, not substring ("ops" will not match "stops"), and is stemmed, so "hire" also finds hiring/hired/hires. A term containing a space is a PHRASE ("cold outbound" requires those words adjacent, in order). Terms combine per `match`. Query operators are not interpreted — a term is searched for literally. Alias of `keywords`; both are combined.',
    example: 'ai agents,claude code',
  },
  { name: 'keywords', type: 'string', description: 'Same as `q`.', example: 'hiring' },
  {
    name: 'semantic',
    type: 'boolean',
    description:
      'Set true to ALSO retrieve by meaning: the query is embedded and matched against post vectors, and those hits are fused with the keyword hits (reciprocal rank fusion). Finds posts that never use your words — "hiring is broken" reaches "recruiting is a mess". Requires q/keywords. All other filters still apply as hard pre-filters. Ordering defaults to the fused rank; `total` is then the size of the fused candidate set, not a corpus-wide count. If the query cannot be embedded the request still succeeds with keyword-only results and a warning.',
    example: 'true',
  },
  {
    name: 'match',
    type: 'string',
    description:
      'How multiple `q`/`keywords` terms combine: `any` returns posts matching at least one term, `all` requires every term. Default: any. Use `all` to narrow a broad topic search.',
    enum: MATCH_MODES,
    example: 'all',
  },
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
      'Only posts whose x_factor (weighted engagement ÷ that author’s current median level, mature posts only) is at least this. Posts with no level yet (x_factor null) are excluded.',
    example: '2',
  },
  {
    name: 'minXScore',
    type: 'number',
    description:
      'Only posts whose x_score (robust rarity z: how many σ above the author’s usual post, §8) is at least this. Posts with no score yet (x_score null) are excluded. Typical thresholds: 1.5 notable, 2.5 rare.',
    example: '2.5',
  },
  {
    name: 'includeProvisional',
    type: 'boolean',
    description:
      'Whether to include posts still inside the 3-day maturity window (x_provisional = 1), whose engagement is still climbing. Default true; set false to see only settled, mature posts.',
    example: 'false',
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
  {
    name: 'sort',
    type: 'string',
    description:
      'Ordering. Default: recent (posted_at desc). `xscore` ranks by the robust rarity z (§8, the recommended outlier sort); `xfactor` ranks by the raw ratio and is kept for back-compat. `relevance` ranks by full-text match quality (bm25) and therefore requires `q`/`keywords`; without them it falls back to recent.',
    enum: SORTS,
  },
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
    path: '/api/v1/posts/{id}/comments',
    operationId: 'getPostComments',
    summary:
      "Stored comments and replies on one post, oldest first. Only the owner's own posts are scraped for comments, so every other post returns an empty list. `parent_comment_id` links a reply to the comment it answers, `is_post_author` marks the owner's replies, and `total_on_linkedin` is LinkedIn's count, so a partial set reads as partial.",
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
    summary: 'The tracked creator list (the accounts scraped on purpose), with tags and personas.',
    params: [
      { name: 'platform', type: 'string', description: 'Filter by platform.', enum: VALID_PLATFORMS },
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
      match: MATCH_MODES,
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
      'x_score = a robust z-score of a post’s logged weighted engagement (likes·1 + comments·3 + shares·5) against the same author’s own recent history: the level is the median log-score of their last 10 mature posts within 60 days, the spread is the MAD of detrended residuals over 180 days (floored at 0.15 log units). x_score is how many σ above (or below) their usual post this one is — 1.5 notable, 2.5 rare. x_factor is the plain ratio of the post’s weighted engagement to that median level. Only mature posts (last measured ≥3 days after posting) feed the baselines; posts under 3 days old carry x_provisional=1 and posts under 1 day old are not scored (x_score null). Both are null until an author has enough history.',
      'Grouping modes return every candidate in `posts` plus the groups as id lists — resolve members by id.',
      'Keyword search is FTS5: whole words (not substrings), stemmed, phrases when a term contains a space. Add semantic=true to union in meaning-based hits.',
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
