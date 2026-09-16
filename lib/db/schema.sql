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

-- 6.1.1 posts_fts — full-text search index over post content (PRD §11.1) -----
-- An EXTERNAL-CONTENT FTS5 table: it stores only the inverted index (word -> post) and reads the
-- text itself back from `posts`, so the 80MB of post content is not duplicated on disk.
--
-- Why this exists: `content LIKE '%kw%'` is substring matching, not search. It matches 'ops' inside
-- "stops"/"loops"/"tops", it cannot match 'hire' against "hiring", and it produces no relevance
-- score, so results can only be ordered by date or engagement. FTS5 fixes all three.
--
-- INVARIANT — the tokenizer is load-bearing: 'porter unicode61' gives word-boundary matching plus
-- English stemming (hire/hiring/hired/hires collapse to one token). CHANGING IT INVALIDATES THE
-- INDEX: bump SCHEMA_VERSION in db.ts so migrate() rebuilds, or searches silently go stale.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  content,
  content='posts',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- External-content tables are NOT auto-synced; these triggers are the contract. The 'delete' command
-- needs the OLD text to know which tokens to remove, which is why old.content is passed back in.
-- The update trigger is scoped to `OF content` so the enrich/x-factor writes (which touch embedding,
-- x_factor, transcript) don't churn the index on every pass.
CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE OF content ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO posts_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 6.2 creators --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creators (
  id            TEXT PRIMARY KEY,              -- crypto.randomUUID()
  platform      TEXT NOT NULL,                 -- 'linkedin' | 'twitter' | 'substack' | 'instagram'
  profile_url   TEXT NOT NULL,                 -- normalized profile url (LinkedIn/X) or https://<pub>.substack.com
  author_id     TEXT,                          -- clean slug/handle for x-factor matching
  display_name  TEXT,
  avatar_url    TEXT,
  persona       TEXT,                          -- §17: the PERSON this account belongs to (normalized name key)
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  market        TEXT NOT NULL DEFAULT 'ai',
  notes         TEXT,
  -- §21.8: opt-in to the daily follower capture. TWO LISTS, ONE ROSTER — every creator here is
  -- scraped for content research; only the flagged subset costs a daily profile call and appears on
  -- the champion leaderboard. Defaults to 0 so adding a creator for research never silently adds a
  -- recurring cost.
  track_followers INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(profile_url)
);
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

-- 6.7 follower_snapshots — daily follower time series per creator (§21) -----
-- `profiles` (§6.6) holds the LATEST full detail for a profile and is overwritten on every
-- re-scrape, so it can answer "how many followers now?" but never "how many yesterday?". This table
-- is the history: append-only, one row per creator per UTC day.
--
-- INVARIANT — the primary key is (author_id, platform, captured_on), so a second capture on the same
-- day REPLACES the first rather than duplicating it. That is what makes a re-run of the daily job
-- safe, and what stops a double run from injecting a phantom zero-gain day into the series.
--
-- INVARIANT — `captured_at` is the real instant and is NOT redundant with `captured_on`. Growth rate
-- is computed from the instants: a 06:00 capture followed by an 18:00 one covers 1.5 days, and
-- differencing the day keys would report that 50% overstated as a daily rate.
--
-- `followers` is never NULL: a profile that returned no count is not recorded at all, because a
-- stored 0 is indistinguishable from an account with zero followers and poisons the delta.
CREATE TABLE IF NOT EXISTS follower_snapshots (
  author_id   TEXT NOT NULL,               -- clean slug/handle — matches creators.author_id, posts.author_id
  platform    TEXT NOT NULL,               -- 'linkedin' | 'twitter' | ...
  captured_on TEXT NOT NULL,               -- 'YYYY-MM-DD' UTC day key
  captured_at TEXT NOT NULL,               -- ISO-8601 UTC instant of the capture
  followers   INTEGER NOT NULL,
  connections INTEGER,                     -- LinkedIn only; NULL elsewhere
  source      TEXT NOT NULL,               -- 'profile-actor' | 'post-author' | 'seed'
  PRIMARY KEY (author_id, platform, captured_on)
);
CREATE INDEX IF NOT EXISTS follower_snapshots_day_idx ON follower_snapshots(platform, captured_on DESC);

-- 6.8 post_snapshots — daily engagement time series per post (§22) ----------
-- `posts` holds a post's LATEST engagement (refreshEngagement overwrites it in place), so it can say
-- how a post is doing now but never how it got there. This table is the curve: append-only, one row
-- per post per UTC day.
--
-- INVARIANT — PK (post_id, captured_on): a second capture in a day REPLACES the first. That is what
-- makes the rolling re-scrape safe to re-run, and stops a double run inserting a phantom flat day.
--
-- INVARIANT — `captured_at` is the real instant and is NOT redundant. Post age (and therefore which
-- "day N" slot a capture fills) is measured from posted_at to captured_at. Two posts published 14
-- hours apart share a capture date while being a day apart in maturity.
--
-- No FK to posts: the snapshot pipeline must never be able to block a post insert, and an orphan row
-- is harmless (it simply never joins).
CREATE TABLE IF NOT EXISTS post_snapshots (
  post_id     TEXT NOT NULL,
  captured_on TEXT NOT NULL,               -- 'YYYY-MM-DD' UTC day key
  captured_at TEXT NOT NULL,               -- ISO-8601 UTC instant of the capture
  likes       INTEGER NOT NULL,
  comments    INTEGER NOT NULL,
  shares      INTEGER NOT NULL,
  PRIMARY KEY (post_id, captured_on)
);
CREATE INDEX IF NOT EXISTS post_snapshots_day_idx ON post_snapshots(captured_on DESC);

-- 6.9 post_comments — comments and replies on HER OWN posts (§23) -----------
-- One row per comment, keyed by LinkedIn's comment id and attached to its post by post_id. A reply
-- carries the id of the comment it answers in parent_comment_id (NULL for a top-level comment).
--
-- INVARIANT — only posts whose author_id equals the own_linkedin_author_id setting ever get rows here.
-- The job refuses any other post BEFORE calling the actor; nothing in this table could tell whose post
-- a comment sits on after the fact.
--
-- A re-scrape UPSERTS on id, so edited text and new likes refresh in place. A comment deleted on
-- LinkedIn is kept: it was said, and the post's live comment count simply stops matching.
--
-- No FK to posts, for the same reason as post_snapshots: storage must never block, and an orphan row
-- simply never joins.
CREATE TABLE IF NOT EXISTS post_comments (
  id                TEXT PRIMARY KEY,           -- LinkedIn comment id
  post_id           TEXT NOT NULL,              -- posts.id (the activity id)
  parent_comment_id TEXT,                       -- the comment this replies to; NULL when top-level
  author_name       TEXT,
  author_id         TEXT,                       -- clean slug (universalName / publicIdentifier)
  author_url        TEXT,
  author_headline   TEXT,                       -- the commenter's headline at scrape time
  author_type       TEXT,                       -- 'profile' | 'company'
  is_post_author    INTEGER NOT NULL DEFAULT 0, -- 1 = written by the post's author (her own replies)
  text              TEXT,
  likes             INTEGER NOT NULL DEFAULT 0,
  replies           INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  edited            INTEGER NOT NULL DEFAULT 0,
  commented_at      TEXT,                       -- ISO-8601 UTC
  scraped_at        TEXT NOT NULL,              -- ISO-8601 UTC of the latest scrape that returned it
  raw_data          TEXT                        -- JSON.stringify of the full Apify item
);
CREATE INDEX IF NOT EXISTS post_comments_post_idx ON post_comments(post_id, commented_at);
