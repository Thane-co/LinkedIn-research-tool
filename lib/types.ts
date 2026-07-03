// Layer 1 — shared TypeScript types (PRD §12 step 11).
// Mirrors the SQLite schema (PRD §6) and the pure-logic I/O shapes.

export type Platform = 'linkedin' | 'twitter'
export type ScrapeSource = 'keyword' | 'creator' | 'both'
export type ScrapeMode = 'keyword' | 'creator' | 'both'
export type JobStatus = 'running' | 'succeeded' | 'failed'
export type CreatorTier = 'core' | 'watch'
export type AuthorType = 'profile' | 'company' | 'verified'
export type Timeframe = 'all' | '24h' | '3d' | 'week' | 'month' | '3months' | 'custom'
export type SortMode = 'recent' | 'likes' | 'xfactor'

// --- posts row (PRD §6.1) --------------------------------------------------
// Vectors are stored as Float32 BLOBs in SQLite; in TS we carry them as Buffer at the
// db boundary and as number[] inside pure logic (via lib/pure/vector-blob.ts).
export interface PostRow {
  id: string
  platform: Platform
  url: string | null
  content: string | null
  author_name: string | null
  author_url: string | null
  author_id: string | null
  author_type: AuthorType | null
  likes: number
  shares: number
  comments: number
  posted_at: string | null
  scraped_at: string
  is_repost: number // 0 | 1
  scrape_source: ScrapeSource | null
  market: string | null

  media: string | null // JSON PostMedia (§10.3.1), null when the post has no media

  embedding: Buffer | null
  image_url: string | null // PRIMARY THUMBNAIL: first image / video poster / doc cover
  image_description: string | null
  image_embedding: Buffer | null
  embedded_at: string | null

  weighted_score: number | null
  creator_baseline: number | null
  x_factor: number | null

  raw_data: string | null
}

// --- creators row (PRD §6.2) -----------------------------------------------
export interface CreatorRow {
  id: string
  platform: Platform
  profile_url: string
  author_id: string | null
  display_name: string | null
  avatar_url: string | null
  tier: CreatorTier
  tags: string // JSON array of strings
  market: string
  notes: string | null
  added_at: string
  updated_at: string
}

// --- scrape_jobs row (PRD §6.3) --------------------------------------------
export interface ScrapeJobRow {
  id: string
  status: JobStatus
  mode: ScrapeMode
  platforms: string // JSON array of Platform
  market: string | null
  params: string | null // JSON
  keyword_raw: number
  creator_raw: number
  merged_total: number
  duplicates: number
  found_in_both: number
  inserted: number
  error: string | null
  started_at: string
  finished_at: string | null
}

// --- settings (PRD §6.4) ---------------------------------------------------
export type SettingsMap = Record<string, string>

// --- Apify raw shapes (PRD §10.3) ------------------------------------------
// Minimal shapes for the fields the mappers read; raw_data preserves the rest.
export interface ApifyPost {
  id?: string
  linkedinUrl?: string
  content?: string | null
  author?: {
    name?: string
    linkedinUrl?: string
    universalName?: string
    publicIdentifier?: string
    type?: AuthorType
  }
  postedAt?: { date?: string }
  engagement?: { likes?: number; comments?: number; shares?: number } | null
  repostedBy?: unknown
  postImages?: { url?: string }[]
  postVideo?: { videoUrl?: string; thumbnailUrl?: string } | null
  document?: {
    title?: string
    transcribedDocumentUrl?: string
    totalPageCount?: number
    coverPages?: { imageUrls?: string[] }[]
  } | null
  [key: string]: unknown
}

// --- Post media (PRD §10.3.1) ----------------------------------------------
// Captured at map time from the raw item; stored as JSON in posts.media, drives card rendering.
export type PostMedia =
  | { type: 'image'; images: string[] }
  | { type: 'video'; url: string; poster: string | null }
  | { type: 'document'; url: string; title: string | null; pages: number | null; cover: string | null }

export interface ApifyTweet {
  id: string
  url?: string
  twitterUrl?: string
  text?: string | null
  author?: { userName?: string; isBlueVerified?: boolean }
  createdAt: string
  likeCount?: number
  retweetCount?: number
  replyCount?: number
  isRetweet?: boolean
  [key: string]: unknown
}

// --- Enriched view shapes (PRD §9) -----------------------------------------
export interface ImageGroup {
  postIds: string[]
  sharedDescription: string | null
  similarity: number // avg pairwise image cosine of the members (0–1)
  totalLikes: number
  totalShares: number
}

export interface ContentCluster {
  postIds: string[]
  label: string | null
  similarity: number // avg pairwise combined similarity of the members (0–1)
  totalLikes: number
  totalShares: number
}

// --- Scrape result stats (PRD §10.5) ---------------------------------------
export interface ScrapeStats {
  keyword_raw: number
  creator_raw: number
  merged_total: number
  duplicates: number
  found_in_both: number
  inserted: number
}
