// Layer 1 — non-secret constants, thresholds, and default actor ids (PRD §12 step 10).
//
// NO SECRETS HERE. API keys are bring-your-own and live in the `settings` table (PRD §6.4),
// read at runtime via getSettings(). This module never throws on missing keys.
//
// The values below are load-bearing invariants (CLAUDE.md). Changing any of them requires
// updating its test AND the PRD in the same change.

// --- X-factor (PRD §8.1) ---------------------------------------------------
export const WEIGHTS = { likes: 1, comments: 3, shares: 5 } as const
export const MIN_SAMPLE_SIZE = 3 // min prior posts to form a baseline
export const BASELINE_WINDOW_DAYS = 30 // lookback window for baseline

// --- Grouping / clustering (PRD §9.2) --------------------------------------
export const IMAGE_SIMILARITY_THRESHOLD = 0.8 // image grouping
export const CONTENT_SIMILARITY_THRESHOLD = 0.65 // content clustering
export const CONTENT_FLOOR = CONTENT_SIMILARITY_THRESHOLD - 0.05 // = 0.60 min-link guard
export const TEXT_WEIGHT = 0.75
export const IMAGE_WEIGHT = 0.25
export const MIN_GROUP_SIZE = 2 // both image groups and content clusters
export const CANDIDATE_CAP = 400 // max posts loaded into an on-demand clustering view

// --- Hybrid retrieval (PRD §9.5) -------------------------------------------
// How many candidates EACH retriever (bm25 and vector) contributes before fusion. Bigger widens
// recall and the fused set the user can page through; the cost is linear and small.
export const RETRIEVAL_CANDIDATES = 500
// Reciprocal Rank Fusion damping. 60 is the standard default: large enough that ranks 1 and 2 are
// not wildly far apart, small enough that the head of each list still dominates the tail.
export const RRF_K = 60

// --- Embeddings (PRD §7) ---------------------------------------------------
export const TEXT_EMBEDDING_MODEL = 'voyage-3'
export const IMAGE_EMBEDDING_MODEL = 'voyage-multimodal-3'
export const EMBEDDING_DIM = 1024
export const EMBEDDING_BATCH_SIZE = 100 // Voyage hard limit is 128; use 100
// Images are DOWNLOADED and sent inline (§7.3), so both a size ceiling and a fetch timeout are ours
// to enforce: an 8MB cap comfortably clears a LinkedIn feed image (~150-400KB) while refusing a
// video file served under an image url.
export const MAX_IMAGE_BYTES = 8_000_000
export const IMAGE_FETCH_TIMEOUT_MS = 30_000
export const VOYAGE_TEXT_URL = 'https://api.voyageai.com/v1/embeddings'
export const VOYAGE_MULTIMODAL_URL = 'https://api.voyageai.com/v1/multimodalembeddings'

// --- Optional image description (PRD §7.4) ---------------------------------
export const IMAGE_DESCRIPTION_MODEL = 'claude-sonnet-4-6'
// Text generation (audience-fit profile rewrite in the daily post-loop). Same pinned Claude model
// as image description — one Anthropic model id for the repo.
export const TEXT_COMPLETION_MODEL = 'claude-sonnet-4-6'

// --- Follower growth (PRD §21) ---------------------------------------------
// The percent board ranks RATE, so it needs a size floor: a 200-follower account gaining 40 people
// scores +20% on noise and would top an unfloored board every day. Applies to the PERCENT board
// only — every creator still ranks on absolute gain.
export const FOLLOWER_PERCENT_FLOOR = 10_000
// A snapshot older than this many days is shown but flagged stale (the row's numbers are last
// known, not current). Sized so one missed daily capture is tolerated and two are not.
export const SNAPSHOT_STALE_DAYS = 2
// $4 per 1,000 profiles on the profile-detail actor's "no email" tier — used to show the running
// cost of a capture before it runs.
export const PROFILE_SCRAPE_COST_PER_PROFILE = 0.004
// §22: harvestapi/linkedin-profile-posts charges per RESULT ITEM, so a rolling re-scrape pays for
// every post it re-reads, not just the new ones. $0.002 is the FREE/BRONZE rate (falls to $0.00175
// SILVER, $0.0015 GOLD+). Confirmed against the actor's live pricing, 2026-09-10.
export const POST_SCRAPE_COST_PER_POST = 0.002
// The actor's postedLimit enum has no 2- or 3-day option (any|1h|24h|week|month|…), so the rolling
// window is 'week' and the day-N comparison is done in SQL over post_snapshots instead.
export const ENGAGEMENT_REFRESH_TIMEFRAME = 'week' as const

// --- Settings defaults (PRD §6.4) ------------------------------------------
// Secret keys start empty; only non-secret config is seeded with defaults.
export const SETTINGS_DEFAULTS = {
  apify_keyword_actor_id: 'harvestapi/linkedin-post-search',
  apify_profile_actor_id: 'harvestapi/linkedin-profile-posts',
  apify_profile_detail_actor_id: 'harvestapi/linkedin-profile-scraper', // scrapes the PROFILE itself (full details + follower count), not its posts (§19)
  apify_tweet_actor_id: 'apidojo/tweet-scraper', // ONE actor for both tweet search & profile modes
  apify_substack_actor_id: 'brilliant_gum/substack-insights-scraper', // ONE actor for both Substack modes (§17)
  apify_instagram_actor_id: 'apify/instagram-post-scraper', // profile/creator posts (photo+video+carousel) (§18)
  default_market: 'ai',
} as const

// Keys that must never be returned raw over the API (PRD §11.4 masks these).
// assemblyai_api_key powers Instagram video transcription (§18);
// readonly_api_token is the bearer token for the read-only agent API (§20).
export const SECRET_SETTING_KEYS = ['apify_api_token', 'voyage_api_key', 'anthropic_api_key', 'assemblyai_api_key', 'readonly_api_token'] as const

// --- Runtime ---------------------------------------------------------------
export const DB_PATH = process.env.DB_PATH ?? './research.db'

// Timeframe -> lookback in days (PRD §11.1)
export const TIMEFRAME_DAYS = {
  '24h': 1,
  '3d': 3,
  week: 7,
  month: 30,
  '3months': 90,
} as const
