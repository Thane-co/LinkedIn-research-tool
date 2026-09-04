// Layer 1 — shared TypeScript types (PRD §12 step 11).
// Mirrors the SQLite schema (PRD §6) and the pure-logic I/O shapes.

export type Platform = 'linkedin' | 'twitter' | 'substack' | 'instagram'
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
  transcript: string | null // §18: speech-to-text of a video post's audio; null until transcribed / N/A

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
  // §17: the PERSON this account belongs to (normalized name key). Accounts sharing a persona are the
  // same person across platforms. Auto-derived from display_name, manually overridable.
  persona: string | null
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

// Substack record (PRD §10.3, §17). Covers BOTH a post/article and a Note — they share engagement
// fields but a note has `type:'note'`, no title/body-markdown, and a `handle` (author) instead of a
// publicationHandle. Field names from the actor's documented output schema; raw_data preserves the rest.
export interface ApifySubstackPost {
  type?: string // 'post' | 'note' (absent → treated as a post); also 'author'/'publication' metadata
  kind?: string // notes only: 'note' (original) | 'restack' (boost of another's post)
  id?: string | number
  slug?: string
  url?: string
  title?: string | null
  subtitle?: string | null
  bodyMarkdown?: string | null
  bodyText?: string | null
  publishedAt?: string | null
  publicationHandle?: string
  publicationName?: string
  publicationUrl?: string
  author?: { name?: string }
  reactionCount?: number
  commentCount?: number
  restackCount?: number
  coverImage?: string | null
  // --- Note-record fields (type:'note'), confirmed from a real run ---
  authorHandle?: string
  authorName?: string
  createdAt?: string | null
  body?: string | null
  attachmentUrls?: string[]
  // restack notes (kind:'restack') boost an article — no body, but the boosted post is here:
  restackedPost?: { title?: string; url?: string; slug?: string }
  restackedPublication?: { name?: string; handle?: string }
  [key: string]: unknown
}

// Instagram post record (apify/instagram-post-scraper output). Covers photo, video, and carousel
// (Sidecar) posts. Field names from the actor's documented output schema; raw_data preserves the rest.
// The post scraper is profile/creator-driven (no keyword search) — transcript is a separate actor (later).
export interface ApifyInstagramPost {
  id?: string
  shortCode?: string // canonical code in the /p/<shortCode>/ url — used to derive the row id
  url?: string
  caption?: string | null
  type?: string // 'Image' | 'Video' | 'Sidecar' (carousel)
  likesCount?: number
  commentsCount?: number
  videoViewCount?: number | null
  timestamp?: string | null
  ownerUsername?: string
  ownerFullName?: string | null
  ownerId?: string
  displayUrl?: string | null // primary thumbnail / video poster
  videoUrl?: string | null
  images?: string[] // carousel image urls (Sidecar); often empty for a single-image post
  [key: string]: unknown
}

// Instagram transcript record (crawlerbros/instagram-transcript-scraper output, §18). One item per
// transcribed video; `fullText` is the transcript, `shortCode`/`postUrl` match it back to a post.
export interface ApifyInstagramTranscript {
  fullText?: string | null
  shortCode?: string
  postUrl?: string
  transcriptionMethod?: string // 'native' | 'whisper'
  [key: string]: unknown
}

// LinkedIn profile record (harvestapi/linkedin-profile-scraper output, §19). Scrapes the PROFILE
// itself — headline/about/experience/skills + the follower & connection counts — NOT its posts.
// Minimal shape for the fields the mapper reads; raw_data preserves the rest. experience/education/
// skills are stored as JSON, so their element shape is left open (unknown[]).
export interface ApifyProfile {
  id?: string
  publicIdentifier?: string
  linkedinUrl?: string
  firstName?: string
  lastName?: string
  name?: string
  headline?: string | null
  about?: string | null
  photo?: string | null
  // The actor may return location as a plain string or a parsed object — the mapper coerces to a string.
  location?: string | { linkedinText?: string; text?: string } | null
  followerCount?: number
  connectionsCount?: number
  experience?: unknown[]
  education?: unknown[]
  skills?: unknown[]
  [key: string]: unknown
}

// --- profiles row (PRD §6.6, §19) ------------------------------------------
export interface ProfileRow {
  id: string // clean publicIdentifier (slug)
  url: string | null
  name: string | null
  headline: string | null
  about: string | null
  followers: number
  connections: number
  location: string | null
  avatar_url: string | null
  experience: string | null // JSON array
  education: string | null // JSON array
  skills: string | null // JSON array
  scraped_at: string
  raw_data: string | null
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
