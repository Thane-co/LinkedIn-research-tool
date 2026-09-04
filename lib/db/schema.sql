-- Full DDL for the local research database (PRD §6). Run idempotently by migrate() in db.ts.
--
-- SQLite type mappings (PRD §6):
--   boolean   -> INTEGER (0/1)
--   timestamp -> TEXT storing ISO-8601 UTC (lexicographic order == chronological order)
--   json      -> TEXT storing JSON.stringify(...)
--   vector    -> BLOB of 1024 little-endian Float32 (4096 bytes); NULL when absent
--
-- Do NOT create a vector index: vectors live in BLOBs and similarity is computed in JS
-- over a candidate set capped at 400 (PRD §9).

-- 6.1 posts -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,          -- canonical post id (PRD §8.2). Tweets prefixed 'tweet-'
  platform          TEXT NOT NULL DEFAULT 'linkedin',  -- 'linkedin' | 'twitter' | 'substack' | 'instagram'
  url               TEXT,                      -- canonical post url (LinkedIn activity url / tweet url)
  content           TEXT,
  author_name       TEXT,
  author_url        TEXT,                      -- profile url (may contain query strings — do NOT match on this)
  author_id         TEXT,                      -- CLEAN slug/handle (LinkedIn universalName, Twitter userName). Match on THIS.
  author_type       TEXT,                      -- 'profile' | 'company' | 'verified'
  likes             INTEGER NOT NULL DEFAULT 0,
  shares            INTEGER NOT NULL DEFAULT 0,
  comments          INTEGER NOT NULL DEFAULT 0,
  posted_at         TEXT,                      -- ISO-8601 UTC
  scraped_at        TEXT NOT NULL,             -- ISO-8601 UTC
  is_repost         INTEGER NOT NULL DEFAULT 0,
  scrape_source     TEXT,                      -- 'keyword' | 'creator' | 'both'
  market            TEXT,                      -- market bucket this scrape ran under, e.g. 'ai'

  media             TEXT,                      -- JSON PostMedia (image[]/video/document), null if none
  transcript        TEXT,                      -- §18: speech-to-text of a video post's audio, null until transcribed

  -- enrichment (nullable until enrich job runs)
  embedding         BLOB,                      -- Float32[1024] of content (+image desc)
  image_url         TEXT,                      -- PRIMARY THUMBNAIL: first image / video poster / doc cover
  image_description TEXT,                      -- optional Claude-vision description
  image_embedding   BLOB,                      -- Float32[1024] of image
  embedded_at       TEXT,                      -- ISO when text embedding written

  -- x-factor (nullable until recompute runs)
  weighted_score    REAL,                      -- likes*1 + comments*3 + shares*5
  creator_baseline  REAL,                      -- avg weighted_score of author's prior 30d posts
  x_factor          REAL,                      -- weighted_score / creator_baseline

  raw_data          TEXT                       -- JSON.stringify of full Apify item
);

CREATE INDEX IF NOT EXISTS posts_posted_at_idx        ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS posts_likes_idx            ON posts(likes DESC);
CREATE INDEX IF NOT EXISTS posts_author_posted_idx    ON posts(author_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS posts_xfactor_idx          ON posts(x_factor DESC);
CREATE INDEX IF NOT EXISTS posts_platform_idx         ON posts(platform);
CREATE UNIQUE INDEX IF NOT EXISTS posts_url_unique_idx ON posts(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_unembedded_idx       ON posts(embedded_at) WHERE embedding IS NULL;

-- 6.2 creators --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creators (
  id            TEXT PRIMARY KEY,              -- crypto.randomUUID()
  platform      TEXT NOT NULL,                 -- 'linkedin' | 'twitter' | 'substack' | 'instagram'
  profile_url   TEXT NOT NULL,                 -- normalized profile url (LinkedIn/X) or https://<pub>.substack.com
  author_id     TEXT,                          -- clean slug/handle for x-factor matching
  display_name  TEXT,
  avatar_url    TEXT,
  persona       TEXT,                          -- §17: the PERSON this account belongs to (normalized name key)
  tier          TEXT NOT NULL DEFAULT 'core',  -- every creator is 'core' (the scrape set); retained for that filter
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  market        TEXT NOT NULL DEFAULT 'ai',
  notes         TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(profile_url)
);
CREATE INDEX IF NOT EXISTS creators_tier_idx ON creators(tier);
-- NOTE: creators_persona_idx is created in db.ts AFTER the additive-column migration (persona may be
-- absent on a legacy db when this file runs, which would make an index-on-persona here fail).

-- 6.3 scrape_jobs -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id              TEXT PRIMARY KEY,            -- crypto.randomUUID()
  status          TEXT NOT NULL,               -- 'running' | 'succeeded' | 'failed'
  mode            TEXT NOT NULL,               -- 'keyword' | 'creator' | 'both'
  platforms       TEXT NOT NULL,               -- JSON array e.g. ["linkedin","twitter"]
  market          TEXT,
  params          TEXT,                        -- JSON: keywords, creatorIds, timeframe, etc.
  keyword_raw     INTEGER DEFAULT 0,
  creator_raw     INTEGER DEFAULT 0,
  merged_total    INTEGER DEFAULT 0,
  duplicates      INTEGER DEFAULT 0,
  found_in_both   INTEGER DEFAULT 0,
  inserted        INTEGER DEFAULT 0,
  error           TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS scrape_jobs_started_idx ON scrape_jobs(started_at DESC);

-- 6.4 settings — BYO keys & configurable actors -----------------------------
-- Single-row-per-key key/value store. The ONLY place keys live; on the user's local disk.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- 6.5 keywords — saved keyword sets per market (Layer 6) ---------------------
-- A market is a user-defined label; the market set = distinct `market` values here.
CREATE TABLE IF NOT EXISTS keywords (
  id         TEXT PRIMARY KEY,            -- crypto.randomUUID()
  market     TEXT NOT NULL,               -- user-defined label, e.g. 'ai'
  term       TEXT NOT NULL,               -- keyword / phrase
  created_at TEXT NOT NULL,               -- ISO-8601 UTC
  UNIQUE(market, term)
);
CREATE INDEX IF NOT EXISTS keywords_market_idx ON keywords(market);

-- 6.6 profiles — scraped LinkedIn PROFILES (§19) ----------------------------
-- One row per LinkedIn profile scraped by the profile-detail actor. Independent of `posts`: a profile
-- is not a post and never enters the x-factor / dedup / enrich pipeline. `id` is the clean public
-- identifier (slug); a re-scrape upserts (refreshes) the row.
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,            -- clean publicIdentifier (slug), e.g. 'basiakubicka'
  url         TEXT,                        -- canonical profile url
  name        TEXT,                        -- first + last
  headline    TEXT,
  about       TEXT,
  followers   INTEGER NOT NULL DEFAULT 0,  -- followerCount
  connections INTEGER NOT NULL DEFAULT 0,  -- connectionsCount
  location    TEXT,
  avatar_url  TEXT,                        -- profile photo
  experience  TEXT,                        -- JSON array (position/company/duration/description)
  education   TEXT,                        -- JSON array (school/degree/field)
  skills      TEXT,                        -- JSON array (name/endorsements)
  scraped_at  TEXT NOT NULL,               -- ISO-8601 UTC
  raw_data    TEXT                         -- JSON.stringify of the full Apify item
);
CREATE INDEX IF NOT EXISTS profiles_scraped_idx ON profiles(scraped_at DESC);
