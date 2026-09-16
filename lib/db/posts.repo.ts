// Layer 2 — post queries (PRD §12 step 13). All SQL for posts lives here (no inline SQL elsewhere).

import { CANDIDATE_CAP, TIMEFRAME_DAYS } from '@/lib/config'
import { getDb } from '@/lib/db/db'
import { buildFtsMatch } from '@/lib/pure/fts-query'
import { blobToVector } from '@/lib/pure/vector-blob'
import type { MatchMode, Platform, PostRow, SortMode, Timeframe } from '@/lib/types'

export interface PostFilters {
  platform?: Platform | 'all'
  // §17.4: a subset of platforms, e.g. ['substack','linkedin']. Takes precedence over `platform`;
  // an empty/absent list applies no platform filter (= all).
  platforms?: Platform[]
  keywords?: string[]
  /** How `keywords` combine: 'any' OR's them (default), 'all' AND's them (§11.1). */
  match?: MatchMode
  authors?: string[]
  minLikes?: number
  minShares?: number
  minXFactor?: number
  timeframe?: Timeframe
  dateFrom?: string
  dateTo?: string
  market?: string
  sort?: SortMode
  page?: number
  pageSize?: number
}

const POST_COLUMNS = `
  id, platform, url, content, author_name, author_url, author_id, author_type,
  likes, shares, comments, posted_at, scraped_at, is_repost, scrape_source, market, media, transcript,
  embedding, image_url, image_description, image_embedding, embedded_at,
  weighted_score, creator_baseline, x_factor, raw_data
`

// `posts` and `posts_fts` BOTH have a `content` column, so a bare `content` is ambiguous once the
// search index is joined. Qualifying every column is valid with or without the join.
const QUALIFIED_POST_COLUMNS = POST_COLUMNS.split(',')
  .map((c) => `posts.${c.trim()}`)
  .filter((c) => c !== 'posts.')
  .join(', ')

/** The FROM clause: the search index is joined ONLY when there is a keyword query to match. */
const FROM_POSTS = 'posts'
const FROM_POSTS_FTS = 'posts JOIN posts_fts ON posts_fts.rowid = posts.rowid'

const INSERT_SQL = `INSERT OR IGNORE INTO posts (${POST_COLUMNS.replace(/\s+/g, ' ').trim()}) VALUES (
  @id, @platform, @url, @content, @author_name, @author_url, @author_id, @author_type,
  @likes, @shares, @comments, @posted_at, @scraped_at, @is_repost, @scrape_source, @market, @media, @transcript,
  @embedding, @image_url, @image_description, @image_embedding, @embedded_at,
  @weighted_score, @creator_baseline, @x_factor, @raw_data
)`

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

export function insertPosts(posts: PostRow[]): { inserted: number } {
  const db = getDb()
  const stmt = db.prepare(INSERT_SQL)
  const tx = db.transaction((rows: PostRow[]) => {
    let inserted = 0
    for (const row of rows) inserted += stmt.run(row).changes
    return inserted
  })
  return { inserted: tx(posts) }
}

/**
 * Deliberately re-check known posts: update likes/shares/comments on EXISTING rows by id only (spec:
 * content loop). Unlike insertPosts' INSERT OR IGNORE, this refreshes the numbers — but it never
 * inserts: an id that isn't in the table is skipped, not created. Scores are NOT touched here; the
 * caller recomputes x-factor via recomputeXFactors([authorId]) exactly as the scrape flow does.
 */
export function refreshEngagement(
  updates: { id: string; likes: number; shares: number; comments: number }[],
): { updated: number } {
  const db = getDb()
  const stmt = db.prepare(
    'UPDATE posts SET likes = @likes, shares = @shares, comments = @comments WHERE id = @id',
  )
  const tx = db.transaction((rows: typeof updates) => {
    let updated = 0
    for (const row of rows) updated += stmt.run(row).changes
    return updated
  })
  return { updated: tx(updates) }
}

/**
 * LinkedIn posts from the recent window for the viral rescan summary (spec: content loop). Best
 * x_factor first (SQLite sorts NULLs last under DESC), likes breaking ties, so a fresh scan surfaces
 * the current top of the last few days. `since` is an ISO-8601 instant (posted_at >= since).
 */
export function getRecentViralLinkedIn(since: string): PostRow[] {
  return getDb()
    .prepare(
      `SELECT ${POST_COLUMNS} FROM posts
       WHERE platform = 'linkedin' AND posted_at >= ?
       ORDER BY x_factor DESC, likes DESC`,
    )
    .all(since) as PostRow[]
}

export function findExistingIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set()
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT id FROM posts WHERE id IN (${placeholders})`)
    .all(...ids) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

export function findExistingUrls(urls: string[]): Set<string> {
  const present = urls.filter((u): u is string => !!u)
  if (present.length === 0) return new Set()
  const placeholders = present.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT url FROM posts WHERE url IN (${placeholders})`)
    .all(...present) as { url: string }[]
  return new Set(rows.map((r) => r.url))
}

/**
 * Build the shared FROM + WHERE clause + bound params from a filter set. `from` joins the FTS index
 * when (and only when) keywords are present; `fts` tells the caller whether bm25 is orderable.
 */
function buildWhere(filters: PostFilters): {
  from: string
  clause: string
  params: unknown[]
  fts: boolean
} {
  const conditions: string[] = []
  const params: unknown[] = []
  let fts = false

  if (filters.platforms && filters.platforms.length > 0) {
    // §17.4 multi-platform subset: platform IN (…). Empty list = no filter (handled by the guard).
    conditions.push(`platform IN (${filters.platforms.map(() => '?').join(',')})`)
    params.push(...filters.platforms)
  } else if (filters.platform && filters.platform !== 'all') {
    conditions.push('platform = ?')
    params.push(filters.platform)
  }
  if (filters.keywords && filters.keywords.length > 0) {
    const match = buildFtsMatch(filters.keywords, filters.match ?? 'any')
    if (match === null) {
      // The user asked for something, and NOTHING they typed is indexable (pure punctuation/emoji).
      // That means zero results — never the whole corpus, which is what dropping the filter here
      // would silently return.
      conditions.push('0')
    } else {
      fts = true
      conditions.push('posts_fts MATCH ?')
      params.push(match)
    }
  }
  if (filters.authors && filters.authors.length > 0) {
    conditions.push(`author_id IN (${filters.authors.map(() => '?').join(',')})`)
    params.push(...filters.authors)
  }
  if (filters.minLikes) {
    conditions.push('likes >= ?')
    params.push(filters.minLikes)
  }
  if (filters.minShares) {
    conditions.push('shares >= ?')
    params.push(filters.minShares)
  }
  if (filters.minXFactor !== undefined) {
    conditions.push('x_factor >= ?') // NULL x_factor is excluded by the comparison
    params.push(filters.minXFactor)
  }
  if (filters.market) {
    conditions.push('market = ?')
    params.push(filters.market)
  }
  if (filters.timeframe === 'custom') {
    if (filters.dateFrom) {
      conditions.push('posted_at >= ?')
      params.push(filters.dateFrom)
    }
    if (filters.dateTo) {
      conditions.push('posted_at <= ?')
      params.push(filters.dateTo)
    }
  } else if (filters.timeframe && filters.timeframe !== 'all') {
    // 'all' = no date restriction (the default landing view: latest posts across all time).
    const days = TIMEFRAME_DAYS[filters.timeframe]
    conditions.push('posted_at >= ?')
    params.push(new Date(Date.now() - days * DAY_MS).toISOString())
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { from: fts ? FROM_POSTS_FTS : FROM_POSTS, clause, params, fts }
}

/** `fts` = the search index is joined, so bm25 is in scope. Without it 'relevance' has nothing to
 *  score and degrades to the default ordering rather than erroring. */
function orderBy(sort: SortMode | undefined, fts: boolean): string {
  switch (sort) {
    case 'likes':
      return 'ORDER BY posts.likes DESC'
    case 'xfactor':
      return 'ORDER BY posts.x_factor DESC' // SQLite sorts NULLs last under DESC
    case 'relevance':
      // bm25 is negative and MORE negative = better, so ascending is best-first. posted_at breaks
      // ties so the ordering is stable rather than whatever the index happens to yield.
      if (fts) return 'ORDER BY bm25(posts_fts), posts.posted_at DESC'
      return 'ORDER BY posts.posted_at DESC'
    default:
      return 'ORDER BY posts.posted_at DESC'
  }
}

export function searchPosts(filters: PostFilters): {
  posts: PostRow[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
} {
  const db = getDb()
  const { from, clause, params, fts } = buildWhere(filters)

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${clause}`).get(...params) as { n: number }
  ).n

  // Clamp defensively: a non-finite page/pageSize would survive Math.min/Math.max as NaN, bind as
  // NULL, and turn `LIMIT ?` into an unbounded scan. This layer owns the invariant regardless of
  // who is calling it (the route parser also drops non-numeric params).
  const finite = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? value : fallback
  const page = Math.max(1, Math.floor(finite(filters.page, 1)))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(finite(filters.pageSize, DEFAULT_PAGE_SIZE))))
  const offset = (page - 1) * pageSize

  const posts = db
    .prepare(
      `SELECT ${QUALIFIED_POST_COLUMNS} FROM ${from} ${clause} ${orderBy(filters.sort, fts)} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as PostRow[]

  return { posts, total, page, pageSize, hasMore: offset + posts.length < total }
}

/**
 * Stream every post that has a text embedding, one row at a time (PRD §9.5). `.iterate()` rather
 * than `.all()` on purpose: materializing ~90k BLOBs as an array first would hold ~360MB of Buffers
 * alongside the ~360MB Float32Array being built from them, doubling peak memory for no reason.
 */
export function* iterateEmbeddedVectors(): Generator<{ id: string; embedding: Buffer }> {
  const rows = getDb()
    .prepare('SELECT id, embedding FROM posts WHERE embedding IS NOT NULL ORDER BY rowid')
    .iterate() as IterableIterator<{ id: string; embedding: Buffer }>
  for (const row of rows) yield row
}

/**
 * Row count and vector width of the embedded corpus, so the index can allocate its matrix EXACTLY
 * once (PRD §9.5). Without this the builder would have to accumulate ~90k decoded vectors as JS
 * arrays before it knew how big the matrix should be — roughly 700MB of garbage on top of the
 * 350MB matrix itself.
 */
export function getEmbeddingStats(): { count: number; dim: number } {
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM posts WHERE embedding IS NOT NULL').get() as { n: number }
  ).n
  if (count === 0) return { count: 0, dim: 0 }
  const bytes = (
    db.prepare('SELECT length(embedding) AS n FROM posts WHERE embedding IS NOT NULL LIMIT 1').get() as {
      n: number
    }
  ).n
  return { count, dim: Math.floor(bytes / 4) } // Float32 = 4 bytes
}

/**
 * The ids passing the HARD filters only — keywords excluded (PRD §9.5). This is the candidate set
 * that both retrievers are restricted to, so platform / engagement / x-factor / timeframe shape the
 * pool BEFORE ranking rather than trimming the results after.
 */
export function getFilteredPostIds(filters: PostFilters): string[] {
  const { from, clause, params } = buildWhere({ ...filters, keywords: undefined })
  return (
    getDb().prepare(`SELECT posts.id FROM ${from} ${clause}`).all(...params) as { id: string }[]
  ).map((r) => r.id)
}

/** Post ids matching the keyword query, best bm25 first, capped at `limit` (PRD §9.5). */
export function searchFtsRankedIds(filters: PostFilters, limit: number): string[] {
  const { from, clause, params, fts } = buildWhere(filters)
  if (!fts) return []
  return (
    getDb()
      .prepare(
        `SELECT posts.id FROM ${from} ${clause} ORDER BY bm25(posts_fts), posts.posted_at DESC LIMIT ?`,
      )
      .all(...params, limit) as { id: string }[]
  ).map((r) => r.id)
}

/** Hydrate posts by id, returned IN THE ORDER GIVEN — the fused ranking, not the table's. */
export function getPostsByIds(ids: string[]): PostRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id IN (${placeholders})`)
    .all(...ids) as PostRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  // A requested id can be absent (deleted between ranking and hydration); drop it rather than
  // emitting a hole in the page.
  return ids.map((id) => byId.get(id)).filter((r): r is PostRow => r !== undefined)
}

/** A full post row plus its decoded vectors — carries every field so the UI can render the member
 *  cards of a group while the pure clustering fns read only the vectors + engagement they need. */
export interface ClusteringCandidate extends PostRow {
  textEmbedding: number[] | null
  imageEmbedding: number[] | null
}

export function getCandidatesForClustering(
  filters: PostFilters,
  requireImageEmbedding: boolean,
): ClusteringCandidate[] {
  const db = getDb()
  const { from, clause, params } = buildWhere(filters)
  const extra = requireImageEmbedding
    ? 'posts.embedding IS NOT NULL AND posts.image_embedding IS NOT NULL'
    : 'posts.embedding IS NOT NULL'
  const where = clause ? `${clause} AND ${extra}` : `WHERE ${extra}`

  const rows = db
    .prepare(
      `SELECT ${QUALIFIED_POST_COLUMNS} FROM ${from} ${where} ORDER BY posts.likes DESC LIMIT ?`,
    )
    .all(...params, CANDIDATE_CAP) as PostRow[]

  return rows.map((r) => ({
    ...r,
    textEmbedding: blobToVector(r.embedding),
    imageEmbedding: blobToVector(r.image_embedding),
  }))
}

/** One post by id, or null — powers the read-only API's single-post lookup (§20). */
export function getPostById(id: string): PostRow | null {
  return (getDb().prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).get(id) as PostRow) ?? null
}

/** Per-platform / per-market corpus summary + enrichment coverage (§20) — what an agent reads first
 *  to know what is actually in the DB before it starts filtering. */
export interface CorpusStats {
  totalPosts: number
  platforms: {
    platform: Platform
    posts: number
    authors: number
    totalLikes: number
    oldestPost: string | null
    newestPost: string | null
  }[]
  markets: { market: string; posts: number }[]
  enrichment: { embedded: number; imageEmbedded: number; withTranscript: number }
  creators: number
  lastScrapedAt: string | null
}

/**
 * The most recent `scraped_at` per platform, or null for a platform with no posts (PRD §11.8).
 * This is the honest "when did we last actually get data here" — a scrape_jobs row only records
 * which platforms were REQUESTED, not which ones returned anything.
 */
export function getLastScrapeByPlatform(): Record<Platform, string | null> {
  const rows = getDb()
    .prepare('SELECT platform, MAX(scraped_at) AS last FROM posts GROUP BY platform')
    .all() as { platform: Platform; last: string | null }[]
  const last: Record<Platform, string | null> = { linkedin: null, twitter: null, substack: null, instagram: null }
  for (const row of rows) {
    if (row.platform in last) last[row.platform] = row.last
  }
  return last
}

export function getCorpusStats(): CorpusStats {
  const db = getDb()
  const platforms = db
    .prepare(
      `SELECT platform, COUNT(*) AS posts, COUNT(DISTINCT author_id) AS authors,
              SUM(likes) AS totalLikes, MIN(posted_at) AS oldestPost, MAX(posted_at) AS newestPost
       FROM posts GROUP BY platform ORDER BY posts DESC`,
    )
    .all() as CorpusStats['platforms']
  const markets = db
    .prepare(
      `SELECT market, COUNT(*) AS posts FROM posts WHERE market IS NOT NULL
       GROUP BY market ORDER BY posts DESC`,
    )
    .all() as CorpusStats['markets']
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS totalPosts,
              SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
              SUM(CASE WHEN image_embedding IS NOT NULL THEN 1 ELSE 0 END) AS imageEmbedded,
              SUM(CASE WHEN transcript IS NOT NULL THEN 1 ELSE 0 END) AS withTranscript,
              MAX(scraped_at) AS lastScrapedAt
       FROM posts`,
    )
    .get() as {
    totalPosts: number
    embedded: number | null
    imageEmbedded: number | null
    withTranscript: number | null
    lastScrapedAt: string | null
  }
  const creators = (db.prepare('SELECT COUNT(*) AS n FROM creators').get() as { n: number }).n

  return {
    totalPosts: counts.totalPosts,
    platforms,
    markets,
    // SUM over zero rows is NULL in SQLite — report 0, never null.
    enrichment: {
      embedded: counts.embedded ?? 0,
      imageEmbedded: counts.imageEmbedded ?? 0,
      withTranscript: counts.withTranscript ?? 0,
    },
    creators,
    lastScrapedAt: counts.lastScrapedAt,
  }
}

export function getAuthorHistory(authorId: string): PostRow[] {
  return getDb()
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE author_id = ? ORDER BY posted_at ASC`)
    .all(authorId) as PostRow[]
}

export interface AvailableAuthor {
  author_id: string
  author_name: string | null
  platform: Platform // which platform this account posts on (drives the dropdown's platform badge)
  avatar: string | null
  isCore: boolean // present in the `creators` table = a creator you follow/scrape
  persona: string | null // §17.3: the person this account belongs to (null for non-creators)
}

/** How "human display name"-like a name variant is, most-preferred first: a real name has a space or
 *  a capital (a bare handle like "aliciateltz" has neither); ties break on post count, then length. */
function nameScore(name: string | null, cnt: number): [number, number, number] {
  const looksHuman = name && (/\s/.test(name) || /[A-Z]/.test(name)) ? 1 : 0
  return [looksHuman, cnt, name?.length ?? 0]
}

function scoreIsBetter(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
}

/**
 * Distinct authors for the creator-filter dropdown (PRD §11.1). Applies the current filters EXCEPT
 * the author include-list (so selecting authors doesn't shrink the dropdown). One row per ACCOUNT
 * (author_id): the same account often accrues posts under both its real name and its bare handle, so
 * we collapse those variants to the most human-looking name (§17.3). Avatar + persona come from the
 * creators table (posts carry neither) by matching author_id.
 */
export function getAvailableAuthors(filters: PostFilters): AvailableAuthor[] {
  const db = getDb()
  const { from, clause, params } = buildWhere({ ...filters, authors: undefined })
  const where = clause
    ? `${clause} AND posts.author_id IS NOT NULL`
    : 'WHERE posts.author_id IS NOT NULL'

  const rows = db
    .prepare(
      `SELECT posts.author_id, posts.author_name, posts.platform, COUNT(*) AS cnt
       FROM ${from} ${where}
       GROUP BY posts.author_id, posts.author_name, posts.platform`,
    )
    .all(...params) as { author_id: string; author_name: string | null; platform: Platform; cnt: number }[]

  // Collapse name variants to one entry per account, keeping the best-scoring display name.
  const byAuthor = new Map<
    string,
    { author_name: string | null; platform: Platform; score: [number, number, number] }
  >()
  for (const r of rows) {
    const score = nameScore(r.author_name, r.cnt)
    const prev = byAuthor.get(r.author_id)
    if (!prev || scoreIsBetter(score, prev.score)) {
      byAuthor.set(r.author_id, { author_name: r.author_name, platform: r.platform, score })
    }
  }

  // Source avatar + persona from the creators table (posts carry neither) by matching author_id.
  const creatorInfo = new Map<string, { avatar: string | null; persona: string | null }>()
  for (const c of db
    .prepare('SELECT author_id, avatar_url, persona FROM creators WHERE author_id IS NOT NULL')
    .all() as { author_id: string; avatar_url: string | null; persona: string | null }[]) {
    creatorInfo.set(c.author_id, { avatar: c.avatar_url, persona: c.persona })
  }

  return [...byAuthor.entries()]
    .map(([author_id, v]) => {
      const info = creatorInfo.get(author_id)
      return {
        author_id,
        author_name: v.author_name,
        platform: v.platform,
        avatar: info?.avatar ?? null,
        isCore: info !== undefined, // present in creators = a creator you follow (§11.1)
        persona: info?.persona ?? null,
      }
    })
    .sort((a, b) => (a.author_name ?? a.author_id).localeCompare(b.author_name ?? b.author_id))
}

/**
 * Instagram video posts still needing a transcript (§18): a video (media.type='video') with a url to
 * transcribe and no transcript yet. Ordered most-liked first so a bounded run transcribes the posts
 * that matter most. json_extract reads the media JSON; a null/non-video media is excluded.
 */
export function getVideoPostsMissingTranscript(limit: number): PostRow[] {
  return getDb()
    .prepare(
      `SELECT ${POST_COLUMNS} FROM posts
       WHERE platform = 'instagram' AND transcript IS NULL AND url IS NOT NULL
         AND json_extract(media, '$.type') = 'video'
       ORDER BY likes DESC LIMIT ?`,
    )
    .all(limit) as PostRow[]
}

/** Count Instagram video posts still awaiting a transcript (§18) — drives "remaining" in the job. */
export function countVideoPostsMissingTranscript(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM posts
         WHERE platform = 'instagram' AND transcript IS NULL AND url IS NOT NULL
           AND json_extract(media, '$.type') = 'video'`,
      )
      .get() as { n: number }
  ).n
}

/** Write a post's video transcript (§18). */
export function setTranscript(id: string, transcript: string): void {
  getDb().prepare('UPDATE posts SET transcript = ? WHERE id = ?').run(transcript, id)
}

export function updateXFactor(
  id: string,
  values: { weighted_score: number; creator_baseline: number | null; x_factor: number | null },
): void {
  getDb()
    .prepare(
      'UPDATE posts SET weighted_score = ?, creator_baseline = ?, x_factor = ? WHERE id = ?',
    )
    .run(values.weighted_score, values.creator_baseline, values.x_factor, id)
}

// A post still needs enrichment when it's missing its text embedding, OR it has a thumbnail
// (image_url) but no image_embedding yet — the latter backfills posts (e.g. videos/documents) that
// were text-embedded before their poster thumbnail existed, so group-by-image (§9) can see them.
const UNEMBEDDED_WHERE = 'embedding IS NULL OR (image_url IS NOT NULL AND image_embedding IS NULL)'

export function getUnembedded(limit: number, opts?: { reEmbed?: boolean }): PostRow[] {
  // Default: rows still missing an embedding (never re-embed a complete one). With reEmbed, load
  // every post up to the limit so a caller can refresh embeddings after adding image descriptions.
  const where = opts?.reEmbed ? '' : `WHERE ${UNEMBEDDED_WHERE}`
  return getDb()
    .prepare(`SELECT ${POST_COLUMNS} FROM posts ${where} ORDER BY scraped_at ASC LIMIT ?`)
    .all(limit) as PostRow[]
}

export function countUnembedded(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${UNEMBEDDED_WHERE}`).get() as { n: number }
  ).n
}

export function setEmbedding(
  id: string,
  embedding: Buffer,
  embeddedAt: string,
  imageEmbedding?: Buffer | null,
  imageDescription?: string | null,
): void {
  const db = getDb()
  if (imageEmbedding !== undefined || imageDescription !== undefined) {
    db.prepare(
      `UPDATE posts SET embedding = ?, embedded_at = ?, image_embedding = ?, image_description = ?
       WHERE id = ?`,
    ).run(embedding, embeddedAt, imageEmbedding ?? null, imageDescription ?? null, id)
  } else {
    db.prepare('UPDATE posts SET embedding = ?, embedded_at = ? WHERE id = ?').run(
      embedding,
      embeddedAt,
      id,
    )
  }
}
