# PRD — Viral Post Research Tool (Local, Standalone)

**Status:** Draft for build
**Author:** Basia Kubicka
**Last updated:** 2026-06-30
**Audience:** Claude Code (this document is the single source of truth to rebuild the product from scratch)

---

## 0. How to read this document

This PRD is written so that a fresh Claude Code session can build the entire product in one pass. Every number, formula,
model name, threshold, column, and index is specified explicitly, together with the rationale for each load-bearing
decision so it is not silently re-derived.

The build is broken into **dependency layers** (Section 12). Build strictly bottom-up:
Layer 0 has zero I/O dependencies and is pure-function + fully unit-tested; each
subsequent layer depends only on layers below it. **Tests are written before
implementation at every layer (TDD, red → green → refactor).**

---

## 1. Product summary

A **single-user, fully-local desktop research tool** for finding viral social posts.
It scrapes posts from **LinkedIn, Twitter/X, and Substack** (by keyword and/or by creator) via
Apify, stores them in a local **SQLite** database, enriches them with **embeddings**
(text + image) and an **x-factor** performance score, and presents them in a filterable
UI where the user can:

- Filter by **x-factor** (overperformance multiplier) and sort by it
- Filter by **platform** (LinkedIn / Twitter / Substack — any subset, e.g. "Substack only" or "Substack + LinkedIn")
- Filter by **time horizon** (last 24h / 3d / week / month / 3 months / custom range)
- Group posts by **image similarity** ("same infographic / visual") and by
  **content similarity** ("trends" — embedding clusters)
- Filter by **keywords**, **creators**, and **engagement floors** (min likes / shares)
- **Add / remove the creators** that get scraped
- **Manually trigger a scrape** with a button (no scheduling)

The only external services are **Apify** (scraping — accepted) and the **Voyage embeddings API** (accepted; embeddings
require a model). Everything else runs on the user's machine.

---

## 2. Goals & non-goals

### 2.1 Goals
- G1 — Build **the research surface** to detect social media trends as a clean,
  standalone, local app.
- G2 — **Zero hosted infra**: no Vercel, no Supabase, no Postgres. Local SQLite file +
  local web server.
- G3 — Use the x-factor math, dedup, image grouping, content clustering, Apify field mapping.
- G4 — Make scraping **manual and on-demand** (button), with live progress.
- G5 — TDD throughout; pure logic 100% covered.

### 2.2 Non-goals 
- N1 — **No post generation.** No drafts, no "create in my voice", no `generated_posts`.
- N2 — **No voice profiles.** No `voice_profiles` table, no voice extraction.
- N3 — **No stored weekly "trends" artefact and no Claude-based trend-clustering job.**
  Grouping is a **live, on-demand embedding view**, not a persisted `trends`/`trend_posts`
  table. (The Claude clustering prompt is removed entirely; clustering is pure vector math.)
- N4 — **No cron / scheduling.** No `vercel.json`, no automated weekly runs. Scrape is
  manual only. (A local scheduler may be added later; out of scope for v1.)
- N5 — No auth, no multi-user, no billing, no RLS. Single user, single machine.
- N6 — No `format_type` / `funnel_stage` classification jobs (those belonged to the
  content-generation half). They may be added later but are not built in v1.

### 2.3 the v1 feature set
Dual scraping (keyword + creator) for **LinkedIn and Twitter** · in-memory + DB dedup ·
text + image embeddings · x-factor compute & filter · image grouping · content clustering
("discover trends") · platform / time-horizon / engagement / keyword / creator filters ·
creator add/remove UI · manual scrape button with progress.

### 2.4 Scale & data provenance
The read / filter / render layer must stay **correct and responsive for datasets on the order of
10⁵ posts and 10³ distinct authors**, whether that data is **accumulated by scraping or bulk-imported**
from an existing store. Two consequences the rest of this PRD depends on:
- **"Creators you follow" ≠ "distinct post authors."** The `creators` table is a curated set of
  hundreds; keyword scraping surfaces **thousands** of one-off authors. Any surface that lists or
  filters by author must treat these as different sets (see §11.1 `availableAuthors` / `isCore`).
- **No unbounded work per request.** Nothing may enumerate the full author set into a URL, render
  every author at once, or return every post in one page (see §11.1 `authors`, §11.5 pagination).
  **Partial enrichment is normal** — an import may carry far fewer embeddings than posts, so
  embedding-dependent views must degrade gracefully, not break.

---

## 3. Tech stack & rationale

| Concern | Choice | Rationale |
|---|---|---|
| Runtime / UI | **Next.js 14 (App Router), run locally** (`next dev` / `next start`) | One toolchain for routes + React UI; runs entirely on the user's machine. |
| Language | **TypeScript, strict mode, no `any`** | Types are load-bearing (schema shapes, vector dims); strict catches drift at compile time. |
| Database | **SQLite** via **`better-sqlite3`** | Embedded, synchronous, zero-config, single file. Fast for local single-user. |
| Vector storage | Embeddings stored as **BLOB (Float32, 1024 dims)** in SQLite | No pgvector / no native vector extension. |
| Vector search | **In-JS cosine similarity** over a capped candidate set (≤400) | O(n²) on ≤400 is trivial; keeps everything in one process. `sqlite-vec` is an optional future optimization, **not** required for v1. |
| Scraping | **Apify** (`apify-client`) | Accepted external dependency. |
| Text embeddings | **Voyage `voyage-3`** (1024-dim) via `https://api.voyageai.com/v1/embeddings` | Strong general text embeddings; 1024-dim keeps BLOBs small. |
| Image embeddings | **Voyage `voyage-multimodal-3`** (1024-dim) via `https://api.voyageai.com/v1/multimodalembeddings` | Same provider/dim as text; enables "same infographic" grouping. |
| Image description (optional) | **Anthropic Claude vision** (`claude-sonnet-4-6`) | Optional enrichment; see §7.4. Can be deferred. |
| Testing | **Vitest** + `@vitest/coverage-v8` | Fast, native ESM/TS; jsdom for component tests. |
| HTTP mocking | **msw** (or `nock`) | Mock Apify / Voyage / Anthropic. |
| **API keys** | **Bring-your-own (BYO).** Each user supplies their own Apify token, Voyage key, and (optional) Anthropic key via an in-app **Settings** screen; stored in the local SQLite DB. **No keys are bundled, hardcoded, or read from a shipped `.env`.** | This is a tool other people run on their own machines with their own accounts — the author never ships or pays for keys. See §6.4 + §13. |

> **Why not Electron / Vite+Hono:** Electron re-packages the whole app and adds a native
> shell to build & ship; Vite+Hono throws away the existing Next.js routes/components and
> forces a full API rewrite. Local Next.js reuses the most and ships fastest. (Decision
> made with the user 2026-06-30.)

---

## 4. High-level architecture

```
                         ┌──────────────────────────────┐
                         │           UI (React)          │  Layer 5
                         │  filter bar · post grid ·      │
                         │  group/cluster views ·         │
                         │  creator manager · scrape btn  │
                         └───────────────┬───────────────┘
                                         │ fetch()
                         ┌───────────────▼───────────────┐
                         │     Next.js API routes         │  Layer 4
                         │  /api/posts /api/creators       │
                         │  /api/scrape  /api/scrape/:id   │
                         └───────────────┬───────────────┘
                                         │
                         ┌───────────────▼───────────────┐
                         │     Orchestration / jobs       │  Layer 3
                         │  runScrape() · enrichPosts()    │
                         │  recomputeXFactors()            │
                         └───┬───────────┬───────────┬────┘
                             │           │           │
           ┌─────────────────▼──┐ ┌──────▼──────┐ ┌──▼──────────────┐
           │   Apify client     │ │  Voyage     │ │  SQLite data    │  Layer 2
           │  (scrape I/O)      │ │  client     │ │  layer (db.ts)  │
           └─────────┬──────────┘ └──────┬──────┘ └──────┬──────────┘
                     │                   │               │
           ┌─────────▼───────────────────▼───────────────▼──────────┐
           │  Pure logic (no I/O):                                   │  Layer 0
           │  x-factor math · dedup · Apify→row mappers ·            │
           │  cosine similarity · image grouping · content cluster ·  │
           │  url canonicalization · serialization helpers           │
           └─────────────────────────────────────────────────────────┘
                                         ▲
                         ┌───────────────┴───────────────┐
                         │  Config / env / types          │  Layer 1
                         └────────────────────────────────┘
```

Dependency rule: **arrows point downward only.** A module never imports from a layer above it.

---

## 5. Repository / file structure

```
/research-tool
  package.json
  tsconfig.json                  ← strict: true
  vitest.config.ts
  next.config.js
  .env.local                     ← NON-SECRET defaults only (DB_PATH); gitignored. No API keys here.
  research.db                    ← SQLite file (holds user's BYO keys + data); gitignored

  /lib
    /config.ts                   ← constants, default actor ids, thresholds  (Layer 1) — NO secrets
    /settings.ts                 ← getSettings()/setSettings(): read/write keys from settings table (Layer 2)
    /http.ts                     ← fetchWithTimeout(): shared per-request timeout wrapper (Layer 2)
    /types.ts                    ← all shared TS types                       (Layer 1)
    /pure
      /x-factor.ts               ← weighted score, baseline, x-factor        (Layer 0)
      /dedup.ts                  ← merge + content-fingerprint dedup         (Layer 0)
      /mappers.ts                ← mapApifyPost / mapApifyTweet → Row         (Layer 0)
      /similarity.ts             ← cosine, combined sim, thresholds          (Layer 0)
      /image-groups.ts           ← union-find image grouping                 (Layer 0)
      /content-clusters.ts       ← average-linkage content clustering        (Layer 0)
      /url.ts                    ← extractActivityId, normalizeProfileUrl, slug/handle (Layer 0)
      /media.ts                  ← extractMedia (image/video/document + thumbnail) (Layer 0)
      /csv.ts                    ← parseCreatorCsv (bulk-import CSV → inputs[]) (Layer 0)
      /lang.ts                   ← isLikelyNonEnglish                         (Layer 0)
      /embed-text.ts             ← buildEmbeddingText (content + image desc)  (Layer 0)
      /vector-blob.ts            ← Float32 ⇄ BLOB serialize/deserialize       (Layer 0)
    /db
      /schema.sql                ← full DDL (tables + indexes)
      /db.ts                     ← getDb()/migrate()/seedSettingsDefaults()/resetDb() (Layer 2)
      /posts.repo.ts             ← post queries (insert, search, group)      (Layer 2)
      /creators.repo.ts          ← creator CRUD                              (Layer 2)
      /jobs.repo.ts              ← scrape_jobs CRUD                          (Layer 2)
      /settings.repo.ts          ← readAllSettings()/writeSettings() row access (Layer 2)
    /apify.ts                    ← Apify client + actor input builders       (Layer 2) — key from settings
    /voyage.ts                   ← embedText / embedImage                    (Layer 2) — key from settings
    /anthropic.ts                ← (optional) image description              (Layer 2) — key from settings
  /jobs
    /scrape.ts                   ← runScrape() orchestration                 (Layer 3)
    /enrich.ts                   ← enrichPosts() embeddings+desc             (Layer 3)
  /app
    /globals.css                 ← design system: tokens + component styles   (Layer 5, §11.7)
    /layout.tsx                  ← root layout; imports globals.css           (Layer 5)
    /api
      /posts/route.ts            ← GET posts (filter/paginate/group)         (Layer 4)
      /creators/route.ts         ← GET/POST/DELETE creators                  (Layer 4)
      /scrape/route.ts           ← POST start scrape                         (Layer 4)
      /scrape/[id]/route.ts      ← GET scrape job status                     (Layer 4)
      /scrape/history/route.ts   ← GET last 20 runs                          (Layer 6)
      /settings/route.ts         ← GET/PUT BYO keys + actor ids              (Layer 4)
      /settings/test/route.ts    ← POST per-provider connection test         (Layer 4)
      /keywords/route.ts         ← GET/POST/DELETE per-market keyword sets    (Layer 6)
    /page.tsx                    ← readiness gate; nav Search ↔ Scrape Settings (Layer 5)
    /DashboardClient.tsx         ← Search screen (header, filters, grid/groups) (Layer 5)
    /DashboardFilterBar.tsx      ← the single search/filter row               (Layer 5)
    /PostCard.tsx                ← one post card                              (Layer 5)
    /ScrapeSettings.tsx          ← Scrape Settings screen (composes below)     (Layer 5)
    /SettingsPanel.tsx           ← onboarding / key entry + connection tests  (Layer 5)
    /CreatorManager.tsx          ← creator list, add / bulk / CSV, remove      (Layer 5)
    /ManualScrape.tsx            ← Run scrape now + status pill                (Layer 5)
    /KeywordsEditor.tsx          ← per-market keyword sets                     (Layer 6)
    /ScrapeHistory.tsx           ← last-20-runs table                         (Layer 6)
  /tests
    /setup.ts
    /fixtures/{apify,voyage,posts}.ts
    /unit/pure/*.test.ts
    /unit/db/*.test.ts
    /unit/jobs/*.test.ts
    /unit/ui/*.test.tsx          ← component tests (jsdom, §13)
    /integration/api/*.test.ts
```

---

## 6. Data schema (SQLite)

> SQLite has no native `boolean`, `uuid`, `timestamptz`, `jsonb`, or `vector`. Mappings:
> - boolean → `INTEGER` (0/1)
> - uuid → not needed (single user); use `TEXT` ids where required
> - timestamp → `TEXT` storing **ISO-8601 UTC** (e.g. `2026-06-30T10:00:00.000Z`).
>   Always store ISO strings so lexicographic comparison == chronological comparison.
> - json → `TEXT` storing `JSON.stringify(...)`
> - vector(1024) → `BLOB` of 1024 little-endian Float32 (4096 bytes). NULL when absent.

### 6.1 `posts`

```sql
CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,          -- canonical post id (see §8.2). Tweets prefixed 'tweet-'
  platform          TEXT NOT NULL DEFAULT 'linkedin',  -- 'linkedin' | 'twitter'
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
  market            TEXT,                      -- market bucket this scrape ran under (§6.5), e.g. 'ai'

  -- media (captured at map time, §10.3). JSON of the post's media for rendering (§11.5)
  media             TEXT,                      -- JSON PostMedia: image[] | video | document | null

  -- enrichment (nullable until enrich job runs)
  embedding         BLOB,                      -- Float32[1024] of content (+image desc)
  image_url         TEXT,                      -- PRIMARY THUMBNAIL: first image / video poster / doc cover (embed + display)
  image_description TEXT,                      -- optional Claude-vision description
  image_embedding   BLOB,                      -- Float32[1024] of the thumbnail
  embedded_at       TEXT,                      -- ISO when text embedding written

  -- x-factor (nullable until recompute runs)
  weighted_score    REAL,                      -- likes*1 + comments*3 + shares*5
  creator_baseline  REAL,                      -- avg weighted_score of author's prior 30d posts
  x_factor          REAL,                      -- weighted_score / creator_baseline

  raw_data          TEXT                       -- JSON.stringify of full Apify item
);
```

#### Indexes
```sql
-- default feed sort
CREATE INDEX IF NOT EXISTS posts_posted_at_idx        ON posts(posted_at DESC);
-- engagement sort / filter
CREATE INDEX IF NOT EXISTS posts_likes_idx            ON posts(likes DESC);
-- x-factor baseline window scan (author history): the hot path for recompute
CREATE INDEX IF NOT EXISTS posts_author_posted_idx    ON posts(author_id, posted_at DESC);
-- x-factor filter/sort
CREATE INDEX IF NOT EXISTS posts_xfactor_idx          ON posts(x_factor DESC);
-- platform filter
CREATE INDEX IF NOT EXISTS posts_platform_idx         ON posts(platform);
-- dedup by url
CREATE UNIQUE INDEX IF NOT EXISTS posts_url_unique_idx ON posts(url) WHERE url IS NOT NULL;
-- find unembedded posts quickly
CREATE INDEX IF NOT EXISTS posts_unembedded_idx       ON posts(embedded_at) WHERE embedding IS NULL;
```

> **Do NOT create a vector index.** Vectors live in BLOBs; similarity is computed in JS on
> a candidate set capped at 400 (§9). 

### 6.1.1 `posts_fts` — full-text search index

Keyword search runs through an **FTS5** index, not `content LIKE '%kw%'`. Substring matching was
wrong on three counts: it matched *inside* words (`ops` hit "stops", "loops", "tops" — ~90% noise on
a real corpus), it could not match word forms (`hire` missed "hiring"), and it produced **no
relevance score**, so results could only be ordered by date or engagement.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  content,
  content='posts',              -- EXTERNAL CONTENT: index only, text read back from posts
  content_rowid='rowid',
  tokenize='porter unicode61'   -- word boundaries + English stemming
);
```

- **External content** (`content='posts'`) so the corpus text is not stored twice. On ~90k posts the
  index costs ~150MB and builds in ~3s.
- **Three triggers** (`posts_fts_insert` / `_delete` / `_update`) keep it in sync; external-content
  tables are not auto-synced. `_update` is scoped `AFTER UPDATE OF content` so enrichment writes
  (embedding, x_factor, transcript) don't churn the index.
- **The tokenizer is load-bearing.** Changing it (or the indexed columns) invalidates the index:
  bump `SCHEMA_VERSION` in `db.ts` so `migrate()` rebuilds, or searches silently go stale.
- **Backfill:** `CREATE TABLE IF NOT EXISTS` gives an existing db an *empty* index, and an empty
  index is indistinguishable from "nothing matched". So the one-time rebuild is gated on
  `PRAGMA user_version` (`SCHEMA_VERSION = 1`), not on inspecting the table.

### 6.2 `creators`

```sql
CREATE TABLE IF NOT EXISTS creators (
  id            TEXT PRIMARY KEY,              -- uuid-ish; generate with crypto.randomUUID()
  platform      TEXT NOT NULL,                 -- 'linkedin' | 'twitter' | 'substack'
  profile_url   TEXT NOT NULL,                 -- normalized profile url (LinkedIn) / https://x.com/<handle> / https://<pub>.substack.com
  author_id     TEXT,                          -- clean slug/handle for x-factor matching
  display_name  TEXT,
  avatar_url    TEXT,
  persona       TEXT,                          -- §17: the PERSON this account belongs to (normalized name key).
                                               -- Accounts sharing a persona = one person across platforms.
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  market        TEXT NOT NULL DEFAULT 'ai',
  notes         TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(profile_url)
);
CREATE INDEX IF NOT EXISTS creators_persona_idx ON creators(persona);
```

> **One creator list (no watch/core split):** every creator is part of the scrape set, so the creator
> list *is* the set a creator/both scrape pulls. There is no `tier` column — it was **removed in
> SCHEMA_VERSION 3** (2026-09-10). It had no UI and no purpose, but it was still being filtered on:
> 7 creators had drifted to `'watch'` and were therefore silently excluded from every default creator
> run, the user's own account among them. A dead column that quietly changes behaviour is worse than
> no column. Membership of the scrape set is now simply "is there a row in `creators`".
>
> Scrape membership does **not** gate x-factor. X-factor is computed for **any** post whose author has
> ≥3 prior posts in the DB within the window (§8.3).
>
> **The one subset that does exist is `track_followers` (§21.8)** — an opt-in flag for the daily
> follower capture. It is deliberately NOT a tier: it never affects what gets scraped, only who costs
> a daily profile call and appears on the champion leaderboard.

### 6.3 `scrape_jobs`

```sql
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
```

### 6.4 `settings` — BYO keys & configurable actors

A single-row key/value store for the user's own credentials and any overridable config.
**No secret is ever hardcoded or shipped; this table is the only place keys live**, and it
lives in the user's local DB file on their own machine.

```sql
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
```

Known keys (seeded with non-secret defaults on first migrate; secrets start NULL/empty):

| key | default | secret? | notes |
|---|---|---|---|
| `apify_api_token` | _(empty)_ | yes | user pastes their own |
| `voyage_api_key` | _(empty)_ | yes | user pastes their own |
| `anthropic_api_key` | _(empty)_ | yes | optional (image descriptions) |
| `apify_keyword_actor_id` | `harvestapi/linkedin-post-search` | no | editable |
| `apify_profile_actor_id` | `harvestapi/linkedin-profile-posts` | no | editable |
| `apify_tweet_actor_id` | `apidojo/tweet-scraper` | no | editable; used for **both** tweet search & profile modes |
| `apify_substack_actor_id` | `brilliant_gum/substack-insights-scraper` | no | editable; used for **both** Substack search & publication modes (§17) |
| `default_market` | `ai` | no | |

Rules:
- **Seeding lives in `db.ts`, not `settings.repo.ts`.** `migrate(db)` runs the schema then calls
  `seedSettingsDefaults(db)` (an `INSERT OR IGNORE` over the non-secret defaults) against the **exact
  db being migrated**. This is co-located with `migrate()` deliberately: it lets migration seed a
  test `:memory:` db and avoids a `db.ts` ↔ `settings.repo.ts` circular import. Secret keys are never
  seeded — they start absent.
- **`getSettings()` also merges defaults at read time** (`{ ...SETTINGS_DEFAULTS, ...storedRows }`,
  stored wins), so the non-secret defaults are always present even against an unseeded db (the
  migrate-time seed and the read-time merge are independent safeguards). `getKey(name)` returns
  `undefined` for an unset **or** empty/cleared value.
- All adapters (`apify.ts`, `voyage.ts`, `anthropic.ts`) read keys via `getSettings()`/`getKey()`,
  never from `process.env`.
- If a **required** key for an action is missing, the API route returns a clear `409`/`412`
  ("Add your Apify token in Settings") and the UI routes the user to the Settings panel —
  scraping/embedding is disabled until keys are present.
- **At-rest note:** keys are stored as plaintext in the local SQLite file (acceptable for a
  single-user local tool — same trust boundary as the user's own disk). OS-keychain storage
  is a possible v1.1 hardening, **not** required for v1. Never log key values.

### 6.5 `keywords` — saved keyword sets per market (Layer 6, §11.6)

The keyword sets the Manual-Scrape "keyword" mode pulls, grouped by **market**. A *market* is just a
user-defined label (e.g. `ai`, `linkedin`, `solution-engineer`); the set of markets is the distinct
`market` column here, seeded with `default_market` (§6.4). A scrape "for market M" pulls M's terms and
**stamps every inserted post with `posts.market = M`** — so `posts.market` records which market bucket
a post was scraped under, and `GET /api/posts?market=M` filters on it.

```sql
CREATE TABLE IF NOT EXISTS keywords (
  id         TEXT PRIMARY KEY,            -- crypto.randomUUID()
  market     TEXT NOT NULL,               -- user-defined label; the market set = distinct values here
  term       TEXT NOT NULL,               -- the keyword/phrase
  created_at TEXT NOT NULL,               -- ISO-8601 UTC
  UNIQUE(market, term)
);
CREATE INDEX IF NOT EXISTS keywords_market_idx ON keywords(market);
```

> **Seeding:** the `keywords` table starts **empty**; only the `default_market` label (§6.4) is
> present as the initial market shown in the editor. Users add their own terms — no keyword set is
> bundled or opinionated.

### 6.6 `profiles` — scraped LinkedIn profiles (§19)

One row per LinkedIn **profile** scraped by the profile-detail actor (§19). Independent of `posts` —
a profile is not a post and never enters the x-factor/dedup/enrich pipeline. `id` is the clean public
identifier (slug); a re-scrape upserts (refreshes) the row.

```sql
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
```

---

## 7. Embeddings specification

### 7.1 Models & dimensions
- **Text:** `voyage-3`, endpoint `POST https://api.voyageai.com/v1/embeddings`, **1024-dim**.
- **Image:** `voyage-multimodal-3`, endpoint `POST https://api.voyageai.com/v1/multimodalembeddings`, **1024-dim**.
- Auth: `Authorization: Bearer <voyage_api_key from settings>` (BYO; §6.4). Never from a shipped env.

### 7.2 Text to embed
Combine post text with the image description (if present) so visual topic signal lands in
the text vector. This is a pure Layer 0 helper (`lib/pure/embed-text.ts`, zero I/O):

```ts
function buildEmbeddingText(content: string | null, imageDescription?: string | null): string {
  const base = (content ?? '').trim()
  if (imageDescription) return `${base}\n\n[Image content: ${imageDescription}]`
  return base
}
```

### 7.3 Batching & storage
- Batch size: **100** inputs per Voyage request (API hard limit 128; use 100).
- On success, serialize each 1024-float vector to a Float32 little-endian BLOB
  (`/lib/pure/vector-blob.ts`) and write to `posts.embedding` (+ `embedded_at = now`).
- **Never re-embed** a post that already has `embedding` unless an explicit `reEmbed`
  flag is passed (used after image descriptions are added). The unembedded loader
  (`getUnembedded(limit, { reEmbed })`) selects a post when it is **missing its text embedding OR it
  has a thumbnail (`image_url IS NOT NULL`) but no `image_embedding`**. The second clause guarantees
  every post with a thumbnail — image, video poster, or document cover — receives an image embedding,
  independently of whether its text embedding is already present, so group-by-image (§9) sees them all.
  Under `reEmbed` the filter is dropped entirely. `countUnembedded` uses the same predicate so
  `remaining` reaches 0.

**Enrich contract** (`enrichPosts(limit, { reEmbed? }) → { embedded, remaining }`, Layer 3):
- Load ≤`limit` candidates, build each embedding text (§7.2), batch-embed, write BLOBs.
- Only call Voyage **text** embedding for candidates actually missing a text embedding (or all, under
  `reEmbed`). A candidate that already has a text embedding but is selected for its missing image
  embedding **reuses its stored text vector** and only embeds the thumbnail — text is never re-embedded
  to add an image.
- `embedded` = posts written this call; `remaining` = posts still lacking an embedding afterward
  (`countUnembedded()`), so a caller can loop until the backlog drains.
- A batch-level Voyage failure **throws** (the caller logs it non-fatally, §10.5). Per-image work is
  independently **non-fatal**: a failed image embed/description is logged and the post still gets its
  text embedding. Writing an embedding **preserves** any existing `image_description` — it is only
  overwritten when Claude returns a new one (so descriptions survive a text-only re-embed).

### 7.3 Image embeddings are uploaded, not linked

`embedImage` **downloads the image and posts it as `image_base64`**. It must never hand Voyage an
`image_url`.

Voyage's server-side fetcher is blocked by LinkedIn's CDN. It answers
`400 "The image URL you have provided is invalid"` for urls that are signed, unexpired, and return
200 to this machine — so the url path embedded **nothing** from LinkedIn, which is ~99% of the
corpus's images, while looking like an ordinary per-image failure.

Because the fetch now runs server-side on scraped input, `embedImage` enforces: **http(s) only**
(same policy as `safeHref`), a **content-type** that starts with `image/`, and a **size ceiling**
(`MAX_IMAGE_BYTES`, 8MB — a LinkedIn feed image is 150-400KB, so this only rejects a video served
under an image url).

**Urls expire, so embed at scrape time.** LinkedIn images carry `?e=<unix-seconds>&v=beta&t=<sig>`.
Once `e` passes the url is a permanent 403 and only a re-scrape can mint another. Measured on this
corpus in Sep 2026: of 39,769 posts still awaiting an image embedding, **34,082 (86%) were already
expired**, 5,973 carried a relative path rather than a url, and of the 4,351 absolute urls
recoverable from `raw_data`, **zero** were still valid. A backfill months after the scrape recovers
almost nothing — which is why `enrichPosts` runs inline right after a scrape.


### 7.4 Image description (OPTIONAL, can be deferred to v1.1)
If enabled: for posts with an image, call Claude vision (`claude-sonnet-4-6`) to produce a
1–2 sentence factual description, store in `image_description`, then (a) embed the image
itself into `image_embedding` via `voyage-multimodal-3`, and (b) include the description in
the text embedded into `embedding`. If disabled, image grouping still works **only if**
`image_embedding` is populated; otherwise image grouping is simply unavailable and content
clustering proceeds on text embeddings alone. **Recommendation:** ship v1 with image
embeddings ON (cheap, enables the "same infographic" grouping) and Claude descriptions OFF
(defer), since descriptions mainly sharpen text clustering.

### 7.5 vector-blob helpers (Layer 0, fully tested)
```ts
export function vectorToBlob(vec: number[]): Buffer        // 1024 Float32 LE → 4096-byte Buffer
export function blobToVector(buf: Buffer | null): number[] | null  // inverse; null-safe
```
Tests: round-trip equality (within Float32 epsilon), wrong-length throws, null → null.

---

## 8. X-factor specification (exact)

### 8.1 Constants (do not change without updating tests)
```ts
export const WEIGHTS = { likes: 1, comments: 3, shares: 5 } as const
export const MIN_SAMPLE_SIZE = 3          // min prior posts to form a baseline
export const BASELINE_WINDOW_DAYS = 30    // lookback window for baseline
```

### 8.2 Weighted score (pure)
```ts
weighted_score = likes * 1 + comments * 3 + shares * 5
```

### 8.3 Baseline & x-factor (pure)
For a post `P` by author `A` posted at time `T`:
1. Collect all **other** posts by `A` with `posted_at` in the **open** interval `(T - 30d, T)` —
   i.e. `T - 30d < posted_at < T`. **Both edges are exclusive:** a post dated exactly 30 days
   before `T` is **excluded** (the boundary is tested explicitly — see §12 Layer 0).
2. If fewer than `MIN_SAMPLE_SIZE` (3) such posts exist → `creator_baseline = null`,
   `x_factor = null`.
3. Else `creator_baseline = mean(weighted_score of those prior posts)`.
4. If `creator_baseline` is `0` or `null` → `x_factor = null`; else
   `x_factor = weighted_score(P) / creator_baseline`.

Pure signature:
```ts
function computeXFactor(
  post: { weighted_score: number; posted_at: string },
  priorPosts: { weighted_score: number; posted_at: string }[]  // same author, pre-filtered to window
): { creator_baseline: number | null; x_factor: number | null }
```

### 8.4 Recompute algorithm (Layer 3, `recomputeXFactors`)
Triggered after every scrape, scoped to the **author_ids that just changed** (not the whole
DB):
1. Collect the distinct `author_id`s among newly-inserted posts.
2. For each such `author_id`, load **all** that author's posts from the DB ordered by
   `posted_at` (uses `posts_author_posted_idx`).
3. For each post by that author, compute `weighted_score`, then the window baseline & x-factor
   per §8.3, and `UPDATE` `weighted_score`, `creator_baseline`, `x_factor`.
4. **Match strictly on `author_id`** (clean slug/handle), **never on `author_url`** — profile urls
   may carry `?miniProfileUrn=…` query strings that break equality, so matching on the url would
   scatter one author's history across several "authors" and corrupt every baseline.
5. Non-fatal: log errors, never let recompute failure abort the scrape.

> Optional optimization: you could update only the most-recent 30d of an author's posts while using
> older ones purely as baseline contributors. For a local single-user DB this is unnecessary —
> recomputing all of an author's posts is simpler. Keep it simple unless perf bites.

---

## 9. Grouping / clustering specification (pure)

Both run **on demand** over a candidate set, **capped at 400 posts** (cheap, plenty —
single-image groups rarely exceed ~20 posts). Vectors are loaded from BLOBs into JS arrays.

### 9.1 Cosine & combined similarity
```ts
cosine(a, b) = dot(a,b) / (norm(a)*norm(b))           // both 1024-dim
// combined similarity used by content clustering:
combined(p, q) =
  (p.imageEmbedding && q.imageEmbedding)
    ? 0.75 * cosine(p.textEmb, q.textEmb) + 0.25 * cosine(p.imgEmb, q.imgEmb)
    : cosine(p.textEmb, q.textEmb)
```

### 9.2 Thresholds (defaults; UI exposes sliders)
```ts
IMAGE_SIMILARITY_THRESHOLD = 0.80   // image grouping
CONTENT_SIMILARITY_THRESHOLD = 0.65 // content clustering
CONTENT_FLOOR = CONTENT_SIMILARITY_THRESHOLD - 0.05  // = 0.60, min-link guard
TEXT_WEIGHT = 0.75
IMAGE_WEIGHT = 0.25
MIN_GROUP_SIZE = 2                   // both image groups and content clusters
```

### 9.3 Image grouping — union-find (`findSimilarImageGroups`)
- Input: posts with non-null `image_embedding`.
- For every pair (i, j), if `cosine(img_i, img_j) >= 0.80`, `union(i, j)`.
- Emit connected components of size `>= 2`.
- Per group: `sharedDescription` = `image_description` of the highest-engagement member
  (fallback to its content snippet); `similarity` = **average pairwise image cosine** of the members
  (0–1, shown as "N% similar"); `totalLikes`, `totalShares` summed; `postIds[]`.
- Sort groups by total engagement (likes + shares) DESC.

### 9.4 Content clustering — greedy average-linkage (`findContentClusters`)
- Input: posts with non-null text `embedding`.
- Precompute all pairwise `combined` similarities (O(n²), n ≤ 400).
- Collect pairs with `sim >= 0.65`, sort by sim DESC.
- For each pair (i, j):
  - both unassigned → start a new cluster `{i, j}`.
  - exactly one assigned to cluster C → add the other **iff**
    `avg_sim(other, members(C)) >= 0.65` **and** `min_sim(other, members(C)) >= 0.60`.
  - both already assigned → skip (no cluster merging).
- Keep clusters of size `>= 2`.
- **Centrality** per member = avg similarity to the other members of its cluster.
  `label` = first sentence (≤100 chars) of the **highest-centrality** post.
- Per cluster: `label`; `similarity` = **average pairwise combined similarity** of the members (0–1);
  `totalLikes`, `totalShares`, `postIds[]`; sort by total engagement DESC.

> Both live in `lib/pure/image-groups.ts` / `lib/pure/content-clusters.ts`. No Claude, no pgvector —
> pure functions, fully unit-testable with small fixture vectors.

---

### 9.5 Hybrid retrieval — keyword ∪ vector (search, not clustering)

§9.1–9.4 use embeddings to GROUP posts already on screen. §9.5 uses them to FIND posts. Different
job, different code path: no candidate cap, no thresholds, no groups.

**Why:** FTS5 (§6.1.1) matches words. It cannot reach a post that says "recruiting is a mess" when
you searched "hiring is broken". Embeddings can. Neither is reliably better, so both run and their
rankings are fused.

**The pipeline** (`semantic=true` + a `q`/`keywords` query):
1. **Hard pre-filters first.** platform / authors / market / minLikes / minShares / minXFactor /
   timeframe define the candidate pool. They shape what each retriever may return — they are not
   applied afterwards, which would leave a narrow filter with almost nothing.
2. **Two retrievers, same pool.** bm25 over `posts_fts`, and cosine over the vector index. Each
   contributes at most `RETRIEVAL_CANDIDATES` (500).
3. **Reciprocal Rank Fusion**, `score = Σ 1/(RRF_K + rank)`, `RRF_K = 60`. Position-based, so the
   two incomparable score scales (bm25 is unbounded negative, cosine is [-1, 1]) never have to be
   normalized or weighted, and a post both retrievers rank highly wins.
4. **Order and page** the fused list. The fused rank is the default order; an explicit `sort`
   re-orders the retrieved set instead.

**The vector index** (`lib/db/vector-index.ts`): every stored embedding decoded ONCE into a single
flat, row-major, unit-normalized `Float32Array`, so each comparison is a dot product. Built lazily on
the first semantic query and cached per database connection; `resetVectorIndex()` after any
embedding write (the enrich job calls it), or newly embedded posts stay invisible until restart.

Measured on the real corpus (89,018 × 1024): **348MB** resident, **~2.7s** one-time build, **~130ms**
per query scan. Still no vector database, still cosine in JS — consistent with the local-only rule.

**Degradation is deliberate.** Semantic search is an enhancement, never a dependency: no Voyage key,
or a failed embed call, returns the keyword results plus a `warnings` entry — never a 5xx. Losing
recall beats losing search.

**`total` changes meaning** in this mode: it is the size of the fused candidate set (≤2×500), not a
corpus-wide count of everything that could match.

**Model lock-in.** Query and documents must come from the SAME model with the SAME `input_type`
(unset, per §7). Vectors from two models are not comparable, so a model change means re-embedding
the whole corpus, not just the gap — see the invariant in CLAUDE.md.


## 10. Scraping specification

### 10.1 Apify actors

**Three actors total.** Default ids are seeded in the `settings` table (§6.4) and are editable in the
Settings UI; the **API token** is the user's own (BYO):

| settings key | default actor | platform / mode |
|---|---|---|
| `apify_keyword_actor_id` | `harvestapi/linkedin-post-search` | LinkedIn — keyword search |
| `apify_profile_actor_id` | `harvestapi/linkedin-profile-posts` | LinkedIn — creator/profile |
| `apify_tweet_actor_id` | `apidojo/tweet-scraper` | **Twitter — BOTH keyword & creator** |
| `apify_substack_actor_id` | `brilliant_gum/substack-insights-scraper` | **Substack — BOTH keyword & creator** (§17) |

> **Twitter uses ONE actor (`apidojo/tweet-scraper`) for both modes** — keyword search passes
> `searchTerms`, creator scrape passes `twitterHandles`; only the *input shape* differs (§10.2).
> Do not split this into two actor ids. **Substack likewise uses ONE actor
> (`brilliant_gum/substack-insights-scraper`) for both modes** — keyword search passes
> `searchQueries`, creator scrape passes `publicationHandles` (§10.2, §17). If the Apify token
> or a needed actor id is empty, skip that scraper gracefully and surface a Settings prompt.

> **Actor-id path encoding:** in Apify REST paths the `/` in an actor id becomes `~`
> (e.g. `acts/harvestapi~linkedin-post-search/runs`). Encode it or every run 404s.

### 10.2 Actor input builders (pure-ish; in `lib/apify.ts`)

**LinkedIn keyword:**
```ts
{ searchQueries: string[], sortBy: 'relevance', postedLimit: <timeframe>,
  maxPosts: 200, scrapeComments: false, scrapeReactions: false }
```
**LinkedIn creator:**
```ts
{ profileUrls: string[], maxPostsPerProfile: <10–100 by timeframe>,
  postedLimit: <'any'|'24h'|'week'|'month'|'3months' by timeframe>, sortBy: 'date' }
```
> **`postedLimit` bounds the creator scrape by DATE, not just count.** Without it, `maxPostsPerProfile`
> alone means "week" pulls the 30 most-recent posts regardless of age (~50 days for a typical creator),
> re-fetching and **re-paying for** posts already in the DB. The profile actor's `postedLimit` enum is
> `any|1h|24h|week|month|3months|6months|year` (NO `past-` prefix — different from the keyword actor).
**Twitter keyword:**
```ts
{ searchTerms: string[], maxItems: 200, sort: 'Top',
  minimumFavorites?: number, start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD', tweetLanguage?: string }
```
**Twitter creator:**
```ts
{ twitterHandles: string[], maxItems: 50, sort: 'Latest', minimumFavorites?: number }
```
**Substack keyword** (input keys confirmed from the actor's input schema, §17):
```ts
{ searchQueries: string[], maxSearchResults: 25, maxPostsPerPublication: <10–100 by timeframe>,
  dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD', minReactions?: number }
```
**Substack creator:**
```ts
{ publicationHandles: string[],  // articles/posts
  userHandles: string[],         // Notes feed (same handles)
  maxPostsPerPublication: <10–500 by timeframe>, maxNotesPerAuthor: <20–500 by timeframe>,
  dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD', minReactions?: number }
```
> **Target by bare handle (`author_id`), NOT the profile url.** The actor scrapes publications; a
> `substack.com/@handle` user-profile url passed via `urls` returns **zero** items. Every Substack
> creator's `author_id` is the clean handle, so the creator scrape passes those as `publicationHandles`
> (articles). **Notes are opt-in** (`includeNotes`): only then does it also pass `userHandles` (the Notes
> feed), because Notes roughly double the actor work/cost — a posts-only run is much faster. Both caps
> ceiling at **500** (the actor's max); `timeframe='all'` uses the ceiling with no date bound =
> full-history backfill. Notes come back as `type:'note'` records; the actor also emits `type:'author'`
> and `type:'publication'` metadata records, which `isSubstackContent` filters out before mapping (§10.3).

Builder function names (in `lib/apify.ts`): `buildLinkedInKeywordInput(keywords, timeframe)`,
`buildLinkedInCreatorInput(profileUrls, timeframe)`, `buildTwitterKeywordInput(keywords, opts?)`,
`buildTwitterCreatorInput(handles, opts?)`, `buildSubstackKeywordInput(keywords, timeframe, opts?)`,
`buildSubstackCreatorInput(handles, timeframe, opts?)`. They are pure — no I/O. Substack reuses the same
`MAX_POSTS_PER_PROFILE[timeframe]` bound as LinkedIn creator (posts-per-publication).

> **Date-bounding by platform (cost control, §17).** Each creator scrape is bounded by date so a short
> timeframe doesn't re-pull (re-pay for) old posts: LinkedIn via the relative `postedLimit` enum (pure,
> in the builder); Substack via an absolute `dateFrom` (YYYY-MM-DD) that `jobs/scrape.ts` computes from
> the timeframe (`now − TIMEFRAME_DAYS`) and passes through `opts` — keeping the builders time-free.
> `'all'`/`'custom'` pass no bound.

**Timeframe → actor bounds** (the `<timeframe>` placeholders above; chosen to bound each scrape):
```ts
POSTED_LIMIT         = { '24h':'past-24h','3d':'past-week','week':'past-week',
                         month:'past-month','3months':'past-month', custom:'any' }  // LinkedIn keyword
MAX_POSTS_PER_PROFILE = { '24h':10,'3d':20,week:30,month:50,'3months':100, custom:50 } // LinkedIn creator
```

### 10.3 Field mapping (pure, `lib/pure/mappers.ts`)

The mappers are **total, pure functions**: they map a raw item to a row and throw only when no id
can be derived. Cross-cutting concerns (language filtering, dedup) live in the scrape job (§10.5),
not here — keeping the mapper a clean, fully-unit-testable transform.

**`mapApifyPostToRow(raw, market): PostRow` (LinkedIn)**
- `id` = canonical activity id from the post URL via `extractActivityId(raw.linkedinUrl)`
  (regex `(?:activity|ugcPost|share)[-:](\d+)`); fallback to `raw.id`. **Derive the id from the
  URL's canonical URN, not `raw.id`** — `raw.id` can be a feed-event URN, which would key the same
  post under different ids across scrapes and defeat dedup.
- `url` = canonical LinkedIn url built from the id.
- `author_url` = `raw.author.linkedinUrl` (may have query string — store but never match on).
- `author_id` = `raw.author.universalName ?? raw.author.publicIdentifier` (clean slug).
- `author_type` = `raw.author.type`.
- `posted_at` = `raw.postedAt.date` (ISO).
- `likes/comments/shares` = `raw.engagement.{likes,comments,shares}` (default 0 if `engagement` null).
- `is_repost` = `!!raw.repostedBy`.
- **Media** (`media` + `image_url` thumbnail) via `extractMedia(raw)` (§10.3.1).
- `platform = 'linkedin'`; `raw_data = JSON.stringify(raw)`; embeddings/x-factor null.
- **Throw** if no id can be derived.

**`mapApifyTweetToRow(raw, market): PostRow` (Twitter)**
- `id` = `tweet-${raw.id}` (prefix prevents collision with LinkedIn ids).
- `url` = `raw.url` (or `twitterUrl`).
- `author_id` = `raw.author.userName` (handle, no `@`).
- `author_type` = `raw.author.isBlueVerified ? 'verified' : 'profile'`.
- `posted_at` = `new Date(raw.createdAt).toISOString()`.
- `likes = raw.likeCount`, `shares = raw.retweetCount`, `comments = raw.replyCount`.
- `is_repost = raw.isRetweet ?? false`.
- `media`/`image_url` = `null` for now — Twitter media mapping is **pending a real tweet payload**
  (the reference scrape was LinkedIn-only; do not guess the `apidojo/tweet-scraper` media field names,
  add them from a captured raw item + fixture).
- `platform = 'twitter'`; `raw_data = JSON.stringify(raw)`.

**`mapApifySubstackToRow(raw, market): PostRow` (Substack)** — field names from the actor's documented
output schema (§17); reconcile against a captured raw item as new fields surface.
- `id` = `substack-${raw.id ?? raw.slug}` (prefix prevents collision with LinkedIn/tweet ids). **Throw**
  if neither `id` nor `slug` is present.
- `url` = `raw.url`.
- `content` = `[raw.title, raw.subtitle, raw.bodyMarkdown].filter(Boolean).join('\n\n')` or null — the
  article title/subtitle/body, so keyword search + embeddings see the full text.
- `author_id` = `raw.publicationHandle` (clean handle — **match on this**).
- `author_url` = `raw.publicationUrl ?? https://${publicationHandle}.substack.com` (null if no handle).
- `author_name` = `raw.author?.name ?? raw.publicationName ?? raw.publicationHandle ?? null`.
- `author_type` = `'profile'`.
- `likes = raw.reactionCount`, `comments = raw.commentCount`, `shares = raw.restackCount` (default 0).
- `posted_at` = `raw.publishedAt` normalized to ISO (invalid/absent → null; never throw).
- `is_repost = 0`.
- **Media**: `raw.coverImage` → `{ type:'image', images:[coverImage] }`, thumbnail = `coverImage`; else
  `null`. (So a Substack cover participates in image grouping like any other thumbnail, §9.)
- `platform = 'substack'`; `raw_data = JSON.stringify(raw)`; embeddings/x-factor null.

#### 10.3.1 Media extraction — `extractMedia(raw)` (pure, `lib/pure/media.ts`)

Confirmed from real `harvestapi/linkedin-post-search` output. Returns `{ media, thumbnail }`:
- **document** (present → wins): `raw.document = { title, transcribedDocumentUrl, totalPageCount,
  coverPages: [{ imageUrls: string[] }] }` → `{ type:'document', url: transcribedDocumentUrl, title,
  pages: totalPageCount, cover: coverPages[0].imageUrls.at(-1) }`. **thumbnail** = `cover`.
- **video** (else): `raw.postVideo = { videoUrl, thumbnailUrl }` → `{ type:'video', url: videoUrl,
  poster: thumbnailUrl }`. **thumbnail** = `poster`.
- **image** (else, if any): `raw.postImages = [{ url }]` (an array — carousels have >1) →
  `{ type:'image', images: postImages.map(i => i.url).filter(Boolean) }`. **thumbnail** = `images[0]`.
- **none**: `media = null`, `thumbnail = null`.

`image_url` = `thumbnail`, so the enrich job embeds it and image-grouping (§9) spans image posts **and
document/video thumbnails** (e.g. the "same carousel" case) uniformly. The full `media` JSON drives
card rendering (§11.5). `raw_data` preserves the entire payload, so `extractMedia` can be recomputed
from it at any time.

`PostMedia` (types.ts):
```ts
type PostMedia =
  | { type: 'image';    images: string[] }
  | { type: 'video';    url: string; poster: string | null }
  | { type: 'document'; url: string; title: string | null; pages: number | null; cover: string | null }
```

#### 10.3.2 Unavailable media degrades to a placeholder

Platform CDN links are **signed and expire**: LinkedIn `media.licdn.com` uses `e=<seconds>` in
decimal, the Instagram/Facebook CDN uses `oe=<seconds>` in **hex**. Once past, the CDN answers 403
forever. Measured Sep 2026: **37,366** posts carry an already-expired thumbnail and **46,466**
`media[]` entries are expired — the large majority of this corpus's images.

`PostImage` (in `PostCard.tsx`) handles the two failure classes differently:

- **Predictable** — `isExpiredMediaUrl` (`lib/pure/url.ts`) reads the expiry straight out of the url,
  so a dead image renders **no `<img>` at all**. That kills both the broken-image icon and the
  pointless round trip through `/api/media`, which would otherwise fetch upstream, take a 403, and
  return 502 once per dead image on screen.
- **Unpredictable** — an unsigned url that has since died, a removed local file, a dead host. Nothing
  to read offline, so the image is attempted and the `<img onError>` swaps in the placeholder.

The placeholder is **not** "render nothing". Whether a post carried an image is itself research
signal; dropping it silently would make an image post read as text-only.

A **locally cached** image (`/post-images/posts/<id>.jpg`, served from `public/`) is not signed and
never expires — `mediaProxySrc` passes a relative path through untouched, and it renders normally.
That local cache is the only durable copy of an image whose CDN link has lapsed.


### 10.4 Deduplication
- **Level 1 (in-memory, pure, `lib/pure/dedup.ts`):** merge keyword + creator arrays into a
  Map keyed by `id`. A post present in both sources gets `scrape_source = 'both'`; otherwise
  `'keyword'` or `'creator'`. Skip rows with null/empty `id`.
- **Level 2 (DB safety net):** before insert, check existence by (a) `id` and (b) `url`
  (unique). Only insert rows that don't already exist. Optionally also fingerprint-dedup on
  `author_id | author_name | first 200 chars of content` to catch reposts with different ids.
- Insert via `INSERT OR IGNORE` (the unique `url` index is the final guard).

### 10.5 Orchestration (`jobs/scrape.ts`, Layer 3)
```ts
async function runScrape(opts: {
  platforms: ('linkedin'|'twitter')[],
  mode: 'keyword'|'creator'|'both',
  keywords?: string[],
  creatorIds?: string[],         // which creators to pull; defaults to every creator (all are 'core')
  timeframe: Timeframe,
  market: string,
  jobId?: string,                // pre-created job row (§10.6); runScrape creates one when absent
}): Promise<ScrapeStats>
```
1. Resolve the `scrape_jobs` row: use `opts.jobId` if provided (the route creates it up front so it
   can return immediately, §10.6), otherwise create one (`status='running'`).
2. **Plan the actor runs** for the requested platforms × mode. Each run is tagged `keyword` or
   `creator`. For creator runs, resolve targets from `creatorIds` (or all `core` creators), split by
   platform → LinkedIn profile urls / Twitter handles. Skip any run whose actor id is unset or whose
   input list is empty (e.g. keyword mode with no keywords, or creator mode with no matching
   creators) — surface a Settings prompt when a needed actor id is missing.
3. Run them with `Promise.all` (each: Apify start → poll status → fetch dataset). Catch **per run**:
   a single actor failure records `raw=0` and must not abort the others. If **every** planned run
   fails, mark the job `failed` and stop (never report an empty success from a total outage).
4. Map each dataset to rows (§10.3); **skip non-English** (`isLikelyNonEnglish` on the mapped
   `content`) and any item the mapper rejects (missing id) — both non-fatal, logged. Merge keyword +
   creator arrays and dedup (§10.4).
5. Determine which rows are new (`findExistingIds`), insert them (`INSERT OR IGNORE`), and record
   counts (`keyword_raw, creator_raw, merged_total, duplicates, found_in_both, inserted`).
6. Mark the job `succeeded` with the stats, then run two **non-fatal** follow-ons: **enrich**
   (drain up to a fixed batch of unembedded posts), then **recomputeXFactors** for the distinct
   `author_id`s among the newly-inserted rows only (§8.4). A failure in either is logged, not raised.
7. `finished_at` is set by the `succeeded`/`failed` transition. Any unexpected error in the pipeline
   marks the job `failed` with the message.

### 10.6 Async progress model (no serverless time limit locally, but keep it responsive)
- `POST /api/scrape` creates the `scrape_jobs` row itself (so it has an id to return synchronously),
  then kicks off `runScrape` with that `jobId` **without awaiting**, and returns `{ jobId }`
  immediately. `runScrape` owns every subsequent status transition on that row.
- `GET /api/scrape/[id]` returns the live `scrape_jobs` row so the UI can poll a progress
  pill ("Scraping… / Scrape complete / N new posts").

### 10.7 Poll & timeout policy
Apify runs are polled every **1500 ms**, up to **400 polls** (~10-min ceiling). Reaching the ceiling
without `SUCCEEDED` **throws a timeout error and the job is marked `failed`** — it is **never reported
`succeeded` with partial data** (a silently-wrong "empty week" is worse than a visible failure).
Per-request fetch timeouts (`AbortSignal.timeout`-equivalent, via `lib/http.ts`): actor start **30 s**,
status poll **30 s**, dataset items **60 s**, Voyage embed batch **60 s**. These bound single-request
latency; the whole-run budget is the poll ceiling (`MAX_POLLS × POLL_INTERVAL`), **not** a fetch
timeout. Retries/backoff are intentionally **deferred** — a dropped embed batch self-heals on the next
enrich run, and a transient scrape error is caught per-actor (`raw=0`); add backoff only if provider
429s appear in practice. If Apify runs frequently sit `QUEUED` and trip the ceiling, raise `MAX_POLLS`
(queue time counts toward it) rather than changing the per-fetch timeouts.

---

## 11. API & data-layer surface

All routes return `NextResponse.json()`. **Every route handler that reads or writes the DB exports
`export const dynamic = 'force-dynamic'`** (§14) — App-Router handlers are statically prerendered by
default, which would freeze DB reads (e.g. settings readiness) at build time. Routes stay thin: parse
→ call a repo/job/pure function → return JSON.

**CSRF guard (local, no-auth server).** Because the app runs unauthenticated on localhost, a site the
user is visiting could try to drive-by a state change. **Every mutating handler (POST/PUT/DELETE)
calls `rejectCrossOrigin(req)` first** (`lib/api-guard.ts`) and returns its **403** when the request's
`Origin` header is present and isn't the local app; requests with no `Origin` (same-origin, tests)
pass. This matters most for `PUT /api/settings` (can overwrite keys) and `POST /api/scrape` (burns
API credits). *Tested per route* + a helper unit test (cross-origin → 403, local/absent → allowed).

### 11.1 `GET /api/posts` — the main read endpoint
Query params:
```
platform=linkedin|twitter|substack|all  (default all; ACCEPTS A COMMA LIST for a subset,
                                          e.g. platform=substack,linkedin. 'all', empty, or the
                                          full set = no platform filter. Unknown tokens ignored;
                                          §17.)
keywords=comma,separated                 (full-text search over content; see below)
match=any|all                            (how keyword terms combine; default any)
semantic=true|false                      (also retrieve by meaning and fuse; needs keywords; §9.5)
authors=comma,separated author_ids       (include filter; EMPTY = all creators, no filter)
minLikes=int  minShares=int              (engagement floors; default 0)
minXFactor=float                          (x_factor >= value; null x_factor excluded)
timeframe=all|24h|3d|week|month|3months|custom   (default all; see landing view below)
dateFrom=ISO  dateTo=ISO                  (when timeframe=custom)
market=string                             (posts.market bucket; §11.6, §6.5)
sort=recent|likes|xfactor|relevance        (default recent; relevance needs keywords)
groupByImage=true|false                   (default false)
discoverTrends=true|false                 (default false)
imageThreshold=float                       (default 0.80)
textThreshold=float                        (default 0.65)
page=int  pageSize=int                      (default 50, max 200)
```
Behavior:
- **Keyword search** (§6.1.1) runs through the `posts_fts` FTS5 index:
  - Matching is by **word**, not substring, and is **stemmed** (`hire` finds hiring/hired/hires).
  - A term containing a space is a **phrase** — `cold outbound` requires those words adjacent, in
    order.
  - `match=any` (default) OR's the terms, preserving the original keyword contract; `match=all`
    AND's them. On the real corpus `cold,outbound,email` goes from 5,072 hits (OR'd) to 125 (AND'd).
  - Terms are **quoted before they reach SQLite** (`lib/pure/fts-query.ts`), so FTS5 query syntax a
    user typed (`AND`, `OR`, `NOT`, `NEAR`, `*`, `:`, `"`) is searched for **literally**, never
    executed, and can never raise a syntax error at query time.
  - A keyword with **no indexable token** (pure punctuation/emoji) matches **nothing**. It must not
    silently drop the filter and return the whole corpus.
  - `sort=relevance` orders by **bm25** (best match first, `posted_at` breaking ties). It needs a
    keyword to score against; without one it falls back to `recent` rather than erroring.
- **Semantic mode** (`semantic=true` with a query, §9.5): the keyword and vector retrievers run over
  the same hard-filtered pool and their rankings are fused. Ordering defaults to the fused rank
  (NOT `recent`) unless `sort` is given explicitly; `total` is the fused candidate-set size. Grouping
  flags take precedence. A failed/absent embedder degrades to keyword-only plus a warning, never a 5xx.
- **Paginated mode** (default): SQL `WHERE` from filters + `ORDER BY` from `sort` + `LIMIT/OFFSET`.
  Response: `{ posts, total, page, pageSize, hasMore, availableAuthors }`, where `hasMore` is exact
  (`offset + posts.length < total`). `posts` are serialized **without** the `embedding`,
  `image_embedding`, and `raw_data` columns (never ship BLOBs/vectors over the wire).
- **Author filtering** (§2.4): an empty `authors` set means **all creators** (no `WHERE` on
  `author_id`). Callers **must never enumerate the full author list** into `authors` — at 10³ authors
  that overflows the request URL (**HTTP 431**); "select all" therefore **clears** the filter rather
  than listing every id. Include-lists are small, hand-picked subsets. If a large explicit set is ever
  required, move filters to a `POST` body — never the query string.
- **Grouping mode** (`groupByImage` or `discoverTrends` true): load up to **400** filtered posts
  that carry the required embeddings, run §9 clustering in JS, and return `{ posts, hasMore:false,
  availableAuthors }` plus **`imageGroups`** (for `groupByImage`) or **`contentClusters`** (for
  `discoverTrends`). The candidate `posts` are **full serialized posts** (same shape as paginated
  mode — BLOBs/`raw_data` stripped, `media` parsed), so the UI renders each group's member cards by
  looking their `postIds` up in `posts` — group membership is shown by the panel, not per-card.
  `groupByImage` takes precedence if both flags are set. `imageThreshold`/`textThreshold` override the §9.2 defaults.
  Each group/cluster carries a `similarity` score (§9.3/§9.4); an empty `imageGroups`/`contentClusters`
  array means nothing met the threshold (the UI shows an empty-state, not a blank page).
- `availableAuthors` (always present) is the **one-row-per-account** `author_id`+`author_name`+
  `platform`+`avatar`+`isCore`+`persona` set for the creator-filter dropdown. It honors the active
  filters **except** the `authors` include-list (so selecting authors never shrinks the dropdown). One
  `author_id` can accrue posts under several name variants (its real name *and* its bare handle); the
  query **collapses these to a single row**, keeping the most human-looking name (a real name has a
  space or a capital; ties break on post count). The `posts` table has **no avatar column**, so
  `avatar` is sourced from `creators.avatar_url` by matching on `author_id` (null when the author isn't
  a tracked creator). **`isCore`** is true when the `author_id` exists in `creators` (a creator you
  follow) vs. a keyword-surfaced one-off author (§2.4). This set may hold **thousands** of authors, so
  the UI **must not** render them all at once or enumerate them into a request (§11.5).

Timeframe → `posted_at >= now - N`: `24h`=1d, `3d`=3d, `week`=7d, `month`=30d, `3months`=90d.
`all` applies **no date restriction** (the default; whole corpus).

**Default landing view** (no params): `timeframe=all`, `authors` empty (all creators), `sort=recent`,
engagement floors `0` — the newest posts across everything, unfiltered. The user narrows from there.

### 11.2 `GET/POST/DELETE /api/creators`
Platform detection / url normalization / `author_id` derivation happen **at the route layer** via
`lib/pure/url.ts`; the repo is storage-only.
- `GET` (optional `?tag=&platform=`) → `{ creators, tags }` (distinct tags across all creators).
- `POST` body `{ input?: string, inputs?: string[], tags?, market?, notes? }` → add one or many.
  Each entry may itself be newline/comma-separated. For each: detect platform (a `linkedin.com`
  url → LinkedIn; a Twitter/X url or bare `@handle` → Twitter), normalize the url, and derive
  `author_id` (`extractLinkedInSlug` for `/in/`|`/company/`, `extractTwitterHandle` for Twitter).
  Auto-fill `display_name` from any existing post by that author. Entries that resolve to no valid
  url/handle are skipped; a body with **zero** valid entries → `400`. Re-adding an existing creator
  is **idempotent** — it updates the display fields and never creates a duplicate. Returns the
  refreshed `{ creators, tags }`.
- **Bulk add is client-side** (§12 step 29): the paste box **and a CSV upload** both produce the
  `inputs[]` array sent to this same `POST` — there is **no file-upload endpoint**, the file is read
  in the browser. CSV rule: one creator per line (LinkedIn/X url or `@handle`); the **first
  comma-cell** of each row is used (so `url,tag,tag` → `url`), surrounding quotes are stripped, and a
  leading **header row** (first cell is a known header word like `url`/`profile_url`/`handle`) is
  skipped. Parsing is the pure helper `lib/pure/csv.ts` (`parseCreatorCsv`).
- `DELETE /api/creators?id=` → remove a creator (`{ ok:true }`); missing `id` → `400`.

### 11.3 `POST /api/scrape` / `GET /api/scrape/[id]`
See §10.6. Before starting, the route checks required keys (Apify token; Voyage key for the
follow-on enrich). If either is missing → `412` with `{ needs: ['apify_api_token', ...] }` so the UI
can deep-link to Settings. Otherwise it creates the job and returns **`202 { jobId }`** immediately.
Body: `{ platforms?, mode?, keywords?, creatorIds?, timeframe?, market?, includeNotes?,
minimumFavorites? }` (defaults: all platforms, `both`, `week`, `market` from `default_market`).
`minimumFavorites` is Twitter-keyword-only (§11.8). `GET /api/scrape/[id]` → the live `scrape_jobs`
row, or `404` when the id is unknown.

`GET /api/scrape/status` → `{ platforms: { <platform>: { lastScrapedAt, creators } } }` — every
platform is present, `lastScrapedAt` is `MAX(posts.scraped_at)` for that platform (null when it has
no posts) and `creators` is how many creator accounts it has. Static `status` segment takes
precedence over the sibling `[id]` dynamic route, same as `history`.

### 11.4 `GET/PUT /api/settings` — BYO keys & actor config
- `GET` → `{ settings, ready }`. `settings` is the full merged map with **secret values masked**
  (`apify_api_token: "set" | "unset"`, never the raw value) alongside the non-secret actor ids;
  `ready` is `{ apify: bool, voyage: bool, anthropic: bool }` the UI uses to gate features.
- `PUT` → upserts provided keys into the `settings` table. Accepts a partial object; only the keys
  present are written; values are trimmed; empty string clears a key. Returns the same masked
  `{ settings, ready }` view so the UI can refresh in place.
- `POST /api/settings/test` (optional but recommended) → runs a cheap live check per provider
  (Apify: `GET /v2/users/me`; Voyage: 1-token embed; Anthropic: 1-token message) and returns
  `{ apify: { ok, error? }, voyage: {…}, anthropic: {…} }`. A provider with no key is reported
  `{ ok:false, error }` without a network call, so onboarding can show green/red without a full scrape.

---

## 11.5 UI wireframes (v1 target)

Two screens: **Search** (the default dashboard) and **Scrape Settings** (creators + keywords + keys
+ manual scrape + history). These wireframes are the source of truth for layout; match them.

### Screen A — Search

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Search Posts                              [▦ grid][≣ list]  [ Group by image ] [ Discover trends ] │
│ Showing 50 of 12,480 matching posts                                                         │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ [Keywords… ] [Creators (All) ▾] [♥ 0] [↗ 0] [✕ 0] [Newest ▾] [All time ▾] [Framework ▾]     │
│                                                              [LinkedIn ✕] [   Search   ]      │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌─ card ───────────────┐  ┌─ card ───────────────┐  ┌─ card ───────────────┐               │
│ │ (A) Alex Wang   🔗 in│  │ (C) Chris Donnelly🔗in │  │ (N) Natan Mohart 🔗in│               │
│ │     Jun 26, 2026     │  │     Jun 26, 2026     │  │     Jun 26, 2026     │               │
│ │  content …see more   │  │  content …see more   │  │  content …see more   │               │
│ │  [    image    ]     │  │  [    image    ]     │  │  [    image    ]     │               │
│ │ 👍1,710 💬92 🔁86 [both] 0.8× │  👍984 💬273 🔁106 [creator]1.2× │  👍1,143 💬159 🔁199 [keyword] │  │
│ └──────────────────────┘  └──────────────────────┘  └──────────────────────┘               │
│  … responsive masonry grid; "list" view is the same cards stacked full-width …               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Header controls (right): **Group by image** and **Discover trends** are toggle buttons that switch
`/api/posts` into grouping mode (§11.1) — active state is visually pressed. Results always render as
the responsive post grid (no list-view toggle).
When a grouping mode is active, a **similarity slider** appears next to it (0.3–0.95) bound to
`imageThreshold` / `textThreshold`, so the user can loosen/tighten grouping live. Each group/cluster
row shows **"N% similar"** (§9.3/§9.4); if nothing groups, an **empty-state** explains why (lower the
slider / try the other mode) instead of a blank page. Sub-header: **"Showing {posts.length} of
{total} matching posts"**.

Filter row → `/api/posts` params (§11.1):
| Control | Param |
|---|---|
| Keywords… (chips) | `keywords` |
| Creators (N) ▾ (empty = **All**; **search-first** type-to-find, no list until you type; empty box shows your current picks + a hint; **Clear** quick-select; platform badge per account; avatars w/ initial fallback) | `authors` |
| ♥ number | `minLikes` |
| ↗ number | `minShares` |
| ✕ number | `minXFactor` |
| Newest ▾ (Newest / Most liked / Highest x-factor) | `sort` |
| All time ▾ (all/24h/3d/week/month/3months/custom) | `timeframe` (+ `dateFrom`/`dateTo`) |
| Framework ▾ (market) | `market` *(§11.6)* |
| LinkedIn ✕ (platform pill; ✕ clears to All) | `platform` |
| Search | re-fetch |

**Behaviors at scale (§2.4):**
- **Default landing view:** all creators, **All time**, Newest, no engagement floors — the newest posts
  across everything, unfiltered. The user narrows from there.
- **Results pagination:** the grid loads one page (default 50) and **auto-loads the next as the user
  nears the bottom** (infinite scroll), with a **"Load more"** button as fallback. `total` can be tens
  of thousands, so there is never an all-at-once render.
- **Creators dropdown (search-first):** empty selection = All. The author set is tens of thousands, so
  the dropdown is a **type-to-find** box, not a scrollable list — **nothing is listed until you type**.
  The empty box shows only the creators you've **already selected** (so your picks stay visible while you
  search) plus a "type a name to find creators across platforms" hint. Typing filters live; rendering is
  still **capped** (§11.1). A single **Clear** quick-select empties the selection (= All). Each account
  row carries a **platform badge** (LinkedIn / Substack / Twitter) so same-named accounts are
  distinguishable; matching accounts of one **person** group under a "People — all accounts" header (by
  `persona`, else a name-derived key — §17.3) for one-click select-all. `getAvailableAuthors` returns
  **one row per account** (`author_id`), collapsing the handle-vs-display-name variants a single account
  accrues into the most human-looking name. Each row shows an avatar, falling back to a **colored
  initial** when the image is missing or expired (imported profile-photo URLs expire). (There is no
  "Core creators" quick-select — the curated subset is managed in the Creators screen, not filtered here.)
- **Numeric filters (♥/↗/✕):** render **empty with a `0` placeholder** (never a stuck literal `0`); ✕
  (min x-factor) accepts decimals.
- **Filter-bar layout:** a **responsive grid** — controls flow into aligned columns and wrap into tidy
  rows; **Search** is a right-aligned trailing action, not a control that shares the wrap.

Post card header: avatar + author + **posted date** on the left; a **🔗 link to the original post**
(opens in a new tab) and the **platform** badge on the right. Body: content with **…see more** expand;
then the post's **media** by `media.type` (§10.3.1): a single **image**, a multi-image **carousel**
(horizontal strip), a **video** (poster + ▶ overlay → opens the original post; licdn streams aren't
played inline in v1), or a **document** (cover image + a `📄 N pages` badge → opens the document url).
Footer: engagement **👍 likes · 💬 comments · 🔁 shares** on the left, and on the right
the **scrape-source badge** (`both`/`creator`/`keyword`) + **x-factor badge** (≥2× green 🔥 / 0.5–2×
gray / <0.5× red / hidden when null). No selection checkbox and no add-to-creators button — creators
are managed on the Scrape Settings screen. (Group membership is shown by the group panel, not on the
card — see §11.5.) All hrefs (the 🔗 link + media links) run the scraped url through **`safeHref`**
(`lib/pure/url.ts`) — only `http(s)` is rendered, so an injected `javascript:`/`data:` url can't
become a clickable link.

### Screen B — Scrape Settings

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Scrape Settings                                                                             │
│ Manage your API keys, creator list, and keywords.                                           │
├─ API keys (bring-your-own; stored locally) ────────────────────────────────────────────────┤
│ Apify API token  [•••• saved]      Voyage API key [•••• saved]   Anthropic key [ not set ]  │
│ Actor ids:  keyword [harvestapi/…]  profile [harvestapi/…]  tweet [apidojo/…]               │
│ [ Save ]  [ Test connection ]     ● apify ok   ● voyage ok   ○ anthropic (not set)          │
├─ Creators   48 tracked ─────────────────────────────────  [ Upload CSV ]  [ Bulk import ] ┤
│ [Profile URL / @handle ...............................]  [Tags: ai, founder]  [ Add ]        │
│ ─────────────────────────────────────────────────────────────────────────────────────────  │
│  (av) Luna Chen        in/luna-chen     [linkedin-growth][lead-magnets]                Remove │
│  (av) Aakash Gupta     in/aagupta       —                                              Remove │
│  …                                                                                          │
├─ Keywords   (per market — used to prefill scrapes)                                          ┤
│  AI            [artificial intelligence ✕][llm ✕][ai ✕][agent ✕]…  + Add keyword   Remove market │
│  LINKEDIN      [claude code content creation ✕][claude code marketing ✕]  + Add keyword          │
│  SOLUTION ENG  [solution engineer ✕][sales engineer ✕]  + Add keyword                            │
│  + Add market                                                                               │
├─ Manual Scrape ──────────────────────────────────────────────  Last run: 6/19 1:38 PM ─────┤
│  Source [Creators + Keywords ▾]  Platform [All ▾]  Time frame [Last week ▾]  Market [All ▾]  │
│  [ Run scrape now ]     48 creators + 19 keywords · 1 week                                   │
├─ Scrape History   (last 20 runs) ───────────────────────────────────────────────────────────┤
│  Date             Source    Platform  Keywords                    Fetched   New              │
│  Jun 19 01:38 PM  Keywords   LinkedIn  solution engineer, …        385       385             │
│  May 29 01:38 AM  Both       All       artificial intelligence, … 3181      3172             │
│  …                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Mapping: **API keys** → §11.4 (`SettingsPanel`). **Creators** → §11.2 (one list; every creator is part
of the scrape set; **Bulk import** = paste many, one per line; **Remove** deletes). **Manual Scrape** →
§11.3 `POST /api/scrape`; the summary line reflects the resolved run (`{creatorCount} creators +
{keywordCount} keywords · {timeframe}`).

> **No scheduler, one creator list (N3/local rule):** there is **no cron/auto-scrape** — every scrape
> is manual (§11.5 Manual Scrape). Creators are a **single list**; all of them are pulled on a
> creator/both run. There is no "watch/core" split or "auto-scraped / scraped weekly" wording — it
> would imply a schedule that does not exist in the UI. The vestigial `tier` column that once encoded
> such a split was dropped in SCHEMA_VERSION 3.

## 11.6 Keywords & scrape history

Two local-only capabilities the wireframes show (SQLite, no new external calls). Built in Layer 6
(§12) once the core read/scrape loop and UI are in place.

- **Scrape history** — `listRecentJobs(limit = 20)` on `jobs.repo.ts` + `GET /api/scrape/history`
  returning the last N `scrape_jobs` rows (read-only; the rows are written by every scrape). Renders
  the history table on Screen B.
- **Markets + saved keywords** — a `keywords` table (`id`, `market`, `term`, `created_at`; unique
  `(market, term)`, §6.5). `GET/POST/DELETE /api/keywords` grouped by market; markets are the distinct
  `market` values. Feeds the Keywords editor and prefills the Manual-Scrape keyword set; the `market`
  filter on `GET /api/posts` reads `posts.market`.
## 11.7 Visual design system

A clean, minimal SaaS look (matches the §11.5 wireframes): light page, white cards with a hairline
border + soft shadow, one blue primary, pill-shaped badges. **One global stylesheet**
`app/globals.css`, imported once by `app/layout.tsx` (Next App Router). No CSS framework, no
CSS-in-JS; components emit **semantic classNames** (`post-card`, `filter-bar`, `badge badge--green`,
`chip`, `creators__row`, …) and the stylesheet targets those — so markup stays test-friendly and
styling never leaks into jsdom component tests (they don't import the CSS).

**Design tokens** (CSS custom properties on `:root`):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f6f7f9` | page background |
| `--surface` | `#ffffff` | cards, inputs |
| `--surface-2` | `#f9fafb` | inset panels (add/bulk rows) |
| `--border` | `#e5e7eb` | hairline card borders |
| `--border-strong` | `#d1d5db` | input/button borders |
| `--text` / `--text-muted` | `#111827` / `#6b7280` | body / meta text |
| `--primary` / `--primary-hover` | `#2563eb` / `#1d4ed8` | primary CTA, links, focus ring |
| `--danger` | `#dc2626` | Remove, failed states |
| `--radius` / `--radius-sm` / `--radius-pill` | `10px` / `6px` / `999px` | cards / controls / pills |
| `--shadow` | `0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1)` | card elevation |
| `--font` | system stack (Inter/–apple-system) | all text |

**x-factor badge tones** map to `badge--green` / `badge--gray` / `badge--red` (from `xFactorBadge`):
green `#dcfce7/#166534`, gray `#f3f4f6/#374151`, red `#fee2e2/#991b1b`. **Chips**: keyword chips light
blue (`#eff6ff/#1d4ed8`), tag chips green (`#dcfce7/#166534`). **Platform** badge indigo.

**Component rules:** cards = `--surface` + `1px --border` + `--radius` + `--shadow`. Buttons are neutral
by default; **primary CTAs** (Search, Save, Add, Import, Run scrape now) are blue — selected by
container context (`.filter-bar__search`, `.manual-scrape > button`, `.creators__add > button`,
`.creators__bulk > button`, `.settings__actions button:first-child`) so **no extra markup** is needed.
Active toggles use `button[aria-pressed='true']` (blue). The post grid is
`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`. Focus
styles use a `--primary` ring for accessibility. Keep it token-driven — tune via tokens, not
scattered values.

---

## 11.8 Per-platform scrape control & the creator table

The platforms are not alike, and bundling them into one "Run scrape now" hid that. LinkedIn is a
curated creator set; Twitter is open keyword discovery; Instagram has no keyword mode at all; Substack
has a Notes feed that roughly doubles a run. So each platform gets its own card and its own settings,
and the creator list is read as one row per **person**.

### Scrape cards (`app/PlatformScrapeCards.tsx`)
One `<fieldset>` per platform, each with: the two source toggles (Creators / Keywords) with live
counts, a timeframe, its platform-specific option, a Run button that POSTs **only that platform**, and
its own status pill. `last scrape: <ago>` comes from `GET /api/scrape/status`.

| Platform | Creators | Keywords | Extra option |
|---|---|---|---|
| LinkedIn | ✓ | ✓ | — |
| X / Twitter | ✓ | ✓ | **Min likes** (`minimumFavorites`) |
| Substack | ✓ | ✓ | **Notes** (`includeNotes`) |
| Instagram | ✓ | **n/a** | — |

`ManualScrape` survives below the cards as the escape hatch: multi-platform in one run, and the only
place to scope a run to a single market.

### Preferences (`lib/pure/scrape-prefs.ts`, Layer 0)
All four cards' settings live in ONE settings row, `scrape_prefs`, as JSON keyed by platform.
`parseScrapePrefs` is deliberately **tolerant** — a malformed, partial, or older row must never throw
or leave a platform undefined; every unrecognized value falls back to its default. Two rules are
enforced at parse time, not just in the UI: a platform in `PLATFORM_SUPPORTS_KEYWORDS` with `false`
can never have `keywords: true`, and a `minimumFavorites` that is not a number above zero becomes
"no floor" (the field is omitted) rather than `0`.

`prefsToMode` maps the toggle pair to the existing `ScrapeMode`: both → `both`, one → `creator` /
`keyword`, neither → `null` (the Run button is disabled; there is nothing to run).

### The Twitter likes floor — keyword runs ONLY
`minimumFavorites` becomes `min_faves` in X's own search index, so the run returns — and Apify bills
for — only tweets that already cleared the bar. It is applied to the **keyword** input and never to
the creator input: x-factor's baseline is the mean weighted score of an author's own prior posts, so
filtering out a creator's weak posts would inflate every baseline and corrupt the score. A test in
`tests/unit/jobs/scrape.test.ts` pins this.

### Creator table (`lib/pure/creator-table.ts`, Layer 0)
Creators are stored one row per account and rendered one row per person, pivoted by platform, so the
per-platform counts are visible and every empty cell is a gap with an add button on it.

- Grouping key: `persona` (§17.2) when set → else `derivePersonaKey(display_name)` → else `id:<id>`.
  An account with neither name nor persona stays on its own row; guessing would silently merge two
  different people.
- A person's **label** is the first real `display_name` among their accounts, whichever platform it
  came from; a handle or url is only a fallback when no account has a name at all.
- A cell holds an **array**, so two accounts on the same platform for one person are both shown
  rather than one being silently dropped.
- Clicking an empty cell prefills the Person field with that row's key, so the new account joins the
  existing person instead of starting a new row.

`POST /api/creators/backfill-personas` fills `persona` from `display_name` for every creator that has
none, and returns `{ updated, creators, tags }`. It only ever writes a NULL persona, so a manual
override is never clobbered, and it skips a name that yields no key rather than guessing. Idempotent.

---

## 12. Build plan — dependency-ordered, TDD

Build strictly in this order. Each step: **write fixtures + failing tests first**, then the
minimal implementation, then refactor. Do not start a layer until the one below is green.

### Layer 0 — Pure logic (no I/O). 100% coverage required.
Order within the layer (each independent, can be parallelized):
1. **`vector-blob.ts`** — round-trip Float32 ⇄ BLOB. *Tests:* round-trip, length guard, null.
2. **`x-factor.ts`** — `weightedScore`, `computeXFactor`. *Tests:* the 1·3·5 weighting; <3
   priors → null; zero baseline → null; correct ratio; window boundary (exactly 30d ago
   excluded/strict `<`).
3. **`similarity.ts`** — `cosine`, `combined`. *Tests:* identical=1, orthogonal=0, the
   0.75/0.25 weighting, missing image falls back to text-only.
4. **`image-groups.ts`** — union-find. *Tests:* two similar imgs group; below-threshold don't;
   transitive A~B~C all in one group; singletons dropped; sorted by engagement; label = top post.
5. **`content-clusters.ts`** — average-linkage. *Tests:* pair above 0.65 clusters; the avg+floor
   join guard; no merging of two assigned clusters; centrality picks label; size<2 dropped.
6. **`url.ts`** — `extractActivityId` (all three URN forms), `normalizeProfileUrl` (strips
   `?miniProfileUrn`), `extractLinkedInSlug` (`/in/`|`/company/` → slug), `extractTwitterHandle`.
   *Tests:* each form + garbage → null.
7. **`lang.ts`** — `isLikelyNonEnglish`. *Tests:* English passes, obvious non-Latin fails, null ok.
8. **`mappers.ts`** — `mapApifyPostToRow`, `mapApifyTweetToRow`. *Tests (from CLAUDE.md spec):*
   correct field mapping; null engagement → 0; null content no throw; **throws on missing id**;
   tweet id prefixed; id derived from URL not raw.id.
9. **`dedup.ts`** — `mergeAndDeduplicate`, `deduplicatePosts`. *Tests:* the full CLAUDE.md dedup
   suite (both→'both', source preservation, empties, null ids, first-wins).
9b. **`embed-text.ts`** — `buildEmbeddingText(content, imageDescription?)` (§7.2). *Tests:* trims
   content, appends the `[Image content: …]` suffix, treats null content / empty description as no-op.
9c. **`csv.ts`** — `parseCreatorCsv(text)` (§11.2): one entry per line, first comma-cell, quotes
   stripped, leading header row dropped. *Tests:* url + `@handle` rows, header skipped, `url,tag,tag`
   → first cell, blank lines/`\r\n` tolerated.
9d. **`media.ts`** — `extractMedia(raw) → { media, thumbnail }` (§10.3.1): document > video > image >
   none precedence; thumbnail derivation. Also **`isPostMedia(v): v is PostMedia`** — a runtime guard
   the read path uses on the stored `media` JSON so a valid-JSON but wrong-shape row is rejected (→
   `null`), not trusted. *Tests (real shapes):* document (cover + pages), video (poster), single image,
   carousel (>1), no-media → `{ null, null }`; `isPostMedia` accepts each variant and rejects
   non-objects / unknown types / wrong field types.

### Layer 1 — Config & types
10. **`config.ts`** — export **non-secret** constants, thresholds, and **default** actor ids.
    No secret loading here (keys live in the settings table, §6.4).
11. **`types.ts`** — `PostRow`, `CreatorRow`, `ScrapeJobRow`, `SettingsMap`, `ApifyPost`,
    `ApifyTweet`, `PostMedia`, `ImageGroup`, `ContentCluster`, `ScrapeStats`, `Timeframe`.
    *Test:* types compile under strict mode (type-level tests optional).

### Layer 2 — I/O adapters (mock all external calls in tests)
> Shared helper: **`lib/http.ts`** — `fetchWithTimeout(url, init, ms)` wraps `fetch` with an
> `AbortController` + `setTimeout` (a plain timer the test suite can drive with fake timers) and
> always clears it. Every external adapter (Apify, Voyage) calls through it for its per-request
> timeouts (§10.7). *Tests:* covered via the adapter abort tests (a hung request rejects).

12. **`db/db.ts` + `schema.sql`** — process-wide `better-sqlite3` singleton with three exports:
    - `getDb(path?)` — returns the singleton. Called with **no arg** in app/repo code (opens at
      `DB_PATH`, migrating on first open). Called **with an explicit path** (e.g. `':memory:'` in
      tests) it closes any current instance and installs a fresh, migrated connection as the new
      singleton — this doubles as the test-injection hook, so repos that call `getDb()` transparently
      hit the test db (no dependency injection needed in repo signatures).
    - `migrate(db?)` — runs `schema.sql` idempotently against `db` (or the singleton), then seeds
      non-secret settings defaults via `seedSettingsDefaults(db)` (§6.4).
    - `resetDb()` — closes and clears the singleton (call in `afterEach` for test isolation).

    *Tests:* `migrate(new Database(':memory:'))` → assert all four tables + the load-bearing indexes
    exist, the unique-url index rejects a dupe, migrate is idempotent, and the non-secret defaults
    are seeded while secret keys stay absent. `getDb(':memory:')` returns a migrated singleton and a
    second explicit call reopens a fresh db.
13. **`db/posts.repo.ts`** — `insertPosts`, `findExistingIds/Urls`, `searchPosts(filters)`,
    `getCandidatesForClustering(filters, requireImageEmbedding)`, `getAuthorHistory(author_id)`,
    `getAvailableAuthors(filters)`, `updateXFactor`, `getUnembedded(limit, { reEmbed? })`,
    `countUnembedded`, `setEmbedding`. Notes: `getCandidatesForClustering` takes a
    `requireImageEmbedding` flag (image grouping needs `image_embedding`; content clustering needs
    only text `embedding`) and orders by `likes DESC` so the 400-cap keeps the most-engaged
    candidates deterministically. It returns **`ClusteringCandidate` = the full `PostRow` + decoded
    `textEmbedding`/`imageEmbedding` `number[]`** — the pure clustering fns read only the vectors +
    engagement, while the route serializes the full rows so the UI can render each group's members.
    `insertPosts` uses `INSERT OR IGNORE` and returns the count actually inserted. `getUnembedded`
    selects rows missing a text embedding **or** having a thumbnail but no `image_embedding` (§7.3)
    unless `reEmbed` is set; `countUnembedded` shares that predicate and backs the enrich `remaining`
    count. `getAvailableAuthors` (§11.1) applies the filters minus the `authors` list and
    joins `creators.avatar_url` on `author_id` for the `avatar` field (posts carry no avatar column).
    *Tests:* against `:memory:` db with seeded rows — filters, pagination/`hasMore`, ordering,
    x-factor update, dedup queries, clustering-candidate decode + image-required filter,
    `reEmbed`/`countUnembedded`, available-authors distinctness + avatar join.
14. **`db/creators.repo.ts`** — surface is `upsertCreator(new)` (insert, or idempotently update the
    display fields when the `profile_url` already exists — no duplicate row; every creator is `core`),
    `listCreators(filter?)` → `{ creators, tags }` (distinct tags across ALL creators — a **corrupt
    `tags` JSON on one row is logged and skipped, never thrown**, so one bad row can't 500 the whole
    list), `deleteCreator(id)`. Storage only — platform detection / url normalization / author_id
    derivation happen at the route layer (§11.2) via `lib/pure/url.ts`. *Tests:* insert, unique url,
    idempotent re-add, tag filter/extraction, corrupt-tags resilience, delete.
15. **`db/jobs.repo.ts`** — `createJob({mode, platforms, market, params})` (status `running`,
    serializes `platforms`/`params` to JSON), `finishJob(id, {status:'succeeded', stats} | {status:'failed', error})`,
    `getJob(id)` → row | null.
16. **`db/settings.repo.ts` + `lib/settings.ts`** —
    - `settings.repo.ts` is thin row access: `readAllSettings()` → `SettingsMap`, `writeSettings(partial)`
      (upsert only the given keys; empty string stored verbatim = "cleared"). Seeding is **not** here —
      it lives in `db.ts`/`migrate()` (§6.4).
    - `lib/settings.ts` is the accessor every adapter uses: `getSettings()` merges
      `SETTINGS_DEFAULTS` under the stored rows (stored wins), `getKey(name)` returns `undefined` for
      unset/empty, `setSettings(partial)` delegates to `writeSettings`, `readiness()` reports which
      providers have their required key present.

    *Tests:* defaults readable after migrate; partial upsert; clear-to-empty; secret round-trip;
    defaults-under-stored merge; `getKey` treats empty as unset; `readiness` flips per key.
17. **`apify.ts`** — the four input builders (§10.2) plus `runActor(actorId, input)`, which
    encapsulates the full run: start → poll to SUCCEEDED → fetch dataset items. (No separate
    `startActor`/`pollRun`/`getResults` public surface — the scrape job calls `runActor` once per
    actor.) **Reads the token from settings** and encodes the actor id `/`→`~` (§10.1). Applies the
    §10.7 policy: per-request timeouts via `fetchWithTimeout`, and **throws a timeout error** if the
    poll ceiling is reached without `SUCCEEDED` (never falls through to fetch a partial dataset).
    *Tests:* msw-mock Apify HTTP; input builders are pure (assert shapes); poll resolves on SUCCEEDED,
    throws on FAILED; **ceiling exhausted → throws and never fetches items**; **a hung fetch aborts**
    via its timeout; actor id is `~`-encoded in the run URL; throws clearly when the token is unset.
18. **`voyage.ts`** — `embedTexts(strings[]) → number[][]`, `embedImage(url) → number[]`.
    **Reads key from settings.** Batches text at 100 and **reorders each batch's vectors by the
    response `index`** before concatenating (preserves input order). Each request goes through
    `fetchWithTimeout` (§10.7). **Validates the response shape** — a 2xx body whose `data` isn't an
    array (or whose items lack an `embedding` array) **throws** rather than passing a corrupt vector
    into the clustering pipeline. *Tests:* msw-mock Voyage; batch of 100; out-of-order response
    reordered; error per-batch throws; **malformed 2xx (no data / missing embedding) throws**; **a
    hung batch aborts** via its timeout; throws when key unset.
19. **`anthropic.ts`** *(optional)* — `describeImage(url) → string | null`. Reads key from settings.
    **Contract:** returns `null` when the key is unset (feature disabled — the enrich job skips
    description); **throws** on an HTTP error so the enrich job can log it non-fatally (§7.4). Mocked.

### Layer 3 — Orchestration jobs
20. **`jobs/enrich.ts`** — `enrichPosts(limit, {reEmbed}) → { embedded, remaining }` (§7.3): load
    unembedded posts, text-embed only those missing a text vector (reuse the stored vector for posts
    that need only their image embedded), embed thumbnails, write BLOBs; per-image embed/describe is
    non-fatal and preserves an existing description. *Tests:* mocks repo + voyage; never re-embeds
    unless `reEmbed` (flag threads to the loader); text-only vs image post write paths; **a post that
    needs only its image embeds the thumbnail without re-embedding text**; per-image failure still
    writes the text vector; `remaining` count correct.
21. **`jobs/scrape.ts`** — `runScrape` (§10.5, accepts an optional pre-created `jobId`) +
    `recomputeXFactors` (§8.4). *Tests:* keyword + creator run in parallel; stats incl. duplicate/both
    counts; one scraper empty still completes; **every scraper failing → job 'failed'** (and enrich is
    skipped); non-English item skipped; x-factor recompute scoped to the just-inserted authors;
    recompute matches on author_id not author_url.

### Layer 4 — API routes (integration tests with a temp db)
22. **`/api/settings`** — GET (masked `{ settings, ready }`) / PUT (partial upsert, returns the same
    view) / POST test (`{ apify, voyage, anthropic }`). *Tests:* secrets masked on GET (raw never
    serialized); partial PUT writes only given keys + trims/clears; `ready` flips per key; test route
    reports per-provider ok/error and skips a keyless provider.
23. **`/api/creators`** — GET/POST/DELETE. *Tests:* add by LinkedIn url (normalized, slug derived) and
    by `@handle`; auto-fill `display_name` from posts; add-many + idempotent re-add; `400` on no
    valid input; list + tag/platform filter; delete (and `400` without id).
24. **`/api/posts`** — paginated + grouping modes. Query parsing **whitelists the enum params**
    (`platform`/`timeframe`/`sort`): an unknown value is **ignored**, not blindly cast (an invalid
    `timeframe` fed to the date math yields an invalid date; an unknown `platform` matches no rows).
    Serialization runs the `media` JSON through **`isPostMedia`** (§10.3.1), so a valid-JSON but
    wrong-shape value becomes `null` rather than a bogus object. *Tests:* each filter; sort modes;
    `hasMore` exactness; BLOBs/`raw_data` stripped; `availableAuthors` always present; **unknown
    `timeframe`/`platform` ignored (no crash / no silent empty)**; **wrong-shape `media` → null**;
    `groupByImage` returns `imageGroups` + full member posts; `discoverTrends` returns
    `contentClusters`; 400-cap respected.
25. **`/api/scrape` + `/api/scrape/[id]`** — start creates the job and returns `202 { jobId }`
    immediately (fires `runScrape` with that id, unawaited); status GET returns the row or `404`.
    *Tests:* `412 { needs }` when Apify/Voyage keys missing (lists only the still-missing ones);
    running job created + `runScrape` handed the `jobId`; `[id]` returns the row and 404s on unknown.

### Layer 5 — UI (component + light e2e). Match the §11.5 wireframes.

**Client data access (`lib/api-client.ts`).** Every component talks to `/api` through one wrapper,
`apiFetch<T>(input, init?)`, never `fetch` directly. It **throws an `ApiError` (carrying `status` +
the parsed error `body`) on a network failure, a non-2xx status, or a malformed JSON body**, so a
failed request can never be silently swallowed (a bare `setState(await res.json())` would leave the UI
frozen on its initial state — blank list, endless "Loading…", or a stuck "Scraping…" pill). Each
component catches it and renders an **error state** with `role="alert"`: `page` shows an error + a
**Retry** (never an endless "Loading…"); read views (Dashboard, Creators, Keywords, History) show an
error banner in place of/above their content; `SettingsPanel` surfaces a save/test failure instead of
falsely reporting success; `ManualScrape` sets the pill to **failed** on a run/poll error. The one
non-error non-2xx is `POST /api/scrape` → **412**: `run()` catches the `ApiError`, reads `body.needs`,
and shows the "Add … in Settings" (`blocked`) pill. *Tests:* `apiFetch` returns JSON on 2xx and throws
`ApiError` with the right `status`/message/body on 5xx, non-JSON, network error, and malformed 2xx;
each component renders its `role="alert"` error state when its request 500s.

26. **`SettingsPanel` + onboarding gate** — paste Apify token, Voyage key, optional Anthropic
    key; edit actor ids; "Test connection" per provider (green/red). On first run (no keys), the
    app opens here and gates Scrape until Apify+Voyage are set. *Tests:* save calls PUT; gate
    shows when `ready.apify`/`ready.voyage` false.
27. **`PostCard`** — header: author + posted date, **🔗 link to the original post** (new tab) +
    platform badge; body: content (truncate/…see more) + **media** by type (§10.3.1): image /
    carousel / video (poster + ▶ → post) / document (cover + `📄 N pages` → doc); footer: engagement
    👍/💬/🔁 on the left and, on the right, scrape-source badge + **x-factor badge** (≥2× green 🔥 /
    0.5–2× gray / <0.5× red / hidden when null). No checkbox, no add-author button.
28. **`DashboardFilterBar`** — single search row (Screen A): keywords chips, creator dropdown
    (collapsed `<details>` with All/None + a checkbox per creator, count in the summary),
    ♥ minLikes / ↗ minShares / ✕ minXFactor, sort, **timeframe select + custom range**, market select,
    platform pill, **Search**. Group-by-image / Discover-trends live in the header (step 30).
29. **`CreatorManager`** — a single creator list (all part of the scrape set); add one (URL/@handle),
    **bulk import** (paste box) or **upload CSV** (client-side file read → same `inputs[]` POST, via
    pure `lib/pure/csv.ts`), Remove. Accepts full LinkedIn/X urls or a Twitter `@handle` (a bare
    non-@ word is treated as a Twitter handle; LinkedIn needs the url).
30. **`DashboardClient`** (Search screen) — header ("Search Posts", "Showing N of M",
    Group-by-image / Discover-trends buttons + a **similarity slider** per active grouping
    mode); fetch `/api/posts`; render grid, or group/cluster panels showing **"N% similar"** that
    **expand (`<details>`) to reveal the member post cards** (looked up from `posts` by `postId`), with
    an **empty-state** when nothing groups. **`ManualScrape`** is a separate component (on Scrape Settings, step 31):
    Source/Platform/Timeframe selects + **Run scrape now** → POST `/api/scrape` → poll status pill.
31. **`page.tsx` + `ScrapeSettings`** — `page.tsx` checks `/api/settings` readiness on mount and
    routes between **Search** (`DashboardClient`) and **Scrape Settings** (`ScrapeSettings`), with
    Search disabled until Apify+Voyage are set. `ScrapeSettings` composes `SettingsPanel` +
    `CreatorManager` + `ManualScrape` (+ Keywords & History once Layer 6 lands).

### Layer 6 — Keywords & scrape history (§11.6)
32. **Scrape history** — `listRecentJobs(20)` + `GET /api/scrape/history` + the history table.
33. **Markets + saved keywords** — `keywords` table, `GET/POST/DELETE /api/keywords`, the Keywords
    editor, `market` filter on `/api/posts`, and Manual-Scrape prefill.

---

## 13. Testing strategy

- **Vitest**, `environment: 'node'` by default (logic/db/routes). **Component tests run under
  jsdom** via a per-file docblock `// @vitest-environment jsdom` (keeps node fast for everything
  else). Deps: `@testing-library/react` + `user-event` + `@testing-library/dom`; matchers from
  `@testing-library/jest-dom/vitest` are registered in `tests/setup.ts`. `vitest.config.ts` sets
  `esbuild: { jsx: 'automatic' }` so component tests need no `React` import. Component tests live in
  `tests/unit/ui/*.test.tsx` and drive `/api/*` through msw (relative fetches match `*/api/...`).
- Coverage `include` is **`lib/**`, `jobs/**`, `app/api/**`** — the `app/*.tsx` UI components are
  intentionally **outside** coverage (behaviour is asserted by component tests, not line counts).
  Thresholds: **lines/functions/branches ≥ 80** globally; **100%** on
  `lib/pure/x-factor.ts`, `lib/pure/dedup.ts`, `lib/pure/mappers.ts`,
  `lib/pure/similarity.ts`, `lib/pure/image-groups.ts`, `lib/pure/content-clusters.ts`,
  `lib/pure/vector-blob.ts`.
- **Never modify a test to make it pass.** Tests define behavior; fix the implementation. If a
  test genuinely must change, ask first and explain why. (Project rule.)
- Mock all external HTTP (Apify, Voyage, Anthropic) with msw. Never hit real APIs in tests.
- DB tests use `better-sqlite3` `:memory:` databases — real SQL, no mock — so schema + queries
  are exercised against the actual engine.
- Fixtures (`/tests/fixtures`): sample Apify LinkedIn items — **one per media kind** (single image,
  carousel, `postVideo`, `document`), an Apify tweet, a Voyage response, and a handful of tiny
  hand-built 1024→(use 4- or 8-dim in tests) embedding vectors for clustering.
  *(Tip: make similarity/clustering functions dimension-agnostic so tests can use 4-dim vectors.)*

---

## 14. Environment / config

**The server binds to loopback only.** `npm run dev`/`start` pass `-H 127.0.0.1`, so the
unauthenticated app is reachable only from this machine — never exposed to the LAN (where anyone
could read scraped data, trigger credit-burning scrapes, or overwrite keys). Combined with the §11
CSRF guard, the two together close "someone else's code talks to your local server."

**No API keys live in env or in the shipped repo.** All credentials are bring-your-own,
entered by each user in the Settings UI and stored in the local `settings` table (§6.4).

`.env.local` (gitignored) holds only **non-secret runtime config**:
```
DB_PATH=./research.db        # where the SQLite file lives (default ./research.db)
```

Everything else — Apify token, Voyage key, optional Anthropic key, the three actor ids, and
`default_market` — is read from the `settings` table at runtime via `getSettings()`. Defaults
for the three actor ids and `default_market` are seeded on first migrate (§6.4); the three
secret keys start empty and are filled in by the user during onboarding.

**Readiness gating:** a feature is enabled only when its required key is present —
- Scraping requires `apify_api_token`.
- Enrichment/embeddings (and thus image/content grouping) requires `voyage_api_key`.
- Image *descriptions* require `anthropic_api_key` (optional; degrades gracefully).

`config.ts` holds no secrets and never throws on missing keys; the adapters and routes do the
"key missing → Settings prompt" handling instead.

**Persistence & no static caching:** the BYO keys (and all data) live in the SQLite file at
`DB_PATH` (default `./research.db`, resolved from the project root — where `next dev`/`next start`
run). `better-sqlite3` writes are synchronous, so a saved key is durable immediately and **persists
across restarts** — the user enters keys once. Because App-Router route handlers are statically
prerendered by default, **every route handler that reads or writes the DB must export
`export const dynamic = 'force-dynamic'`** so it always runs against the live DB and is never frozen
at build time — otherwise `GET /api/settings` would serve a build-time snapshot and readiness would
never reflect saved keys. (Deleting `research.db`, or launching from a different working directory, is
the only way to "lose" keys.)

---

## 15. Acceptance criteria (v1 done when…)

1. `npm run test` green; coverage thresholds met (incl. 100% on the listed pure modules).
2. From a clean machine: `npm i && npm run dev`, open localhost, DB auto-migrates on first run.
3. **First-run onboarding**: with no keys, the app opens the **Scrape Settings** screen and the
   **Search** tab is disabled. After pasting a user's own Apify + Voyage keys (and optionally
   Anthropic) and passing the per-provider connection tests, Search unlocks. **No key was bundled.**
4. Two screens reachable from the top nav — **Search** (`DashboardClient`) and **Scrape Settings**
   (`ScrapeSettings`: keys + creators + keywords + Manual Scrape); the §11.7 design system is applied
   (global `app/globals.css`).
5. Add a LinkedIn creator and a Twitter creator via the UI; both persist and appear in the list.
6. On **Scrape Settings**, **Run scrape now** → progress pill → new posts appear on **Search**; a
   second identical scrape inserts **0** new posts (dedup proven).
7. Posts show correct platform + scrape-source badges; x-factor badges appear for authors with
   ≥3 prior posts in window.
8. Filters work and compose: platform, keywords, creators, min likes/shares, **min x-factor**,
   and **time horizon** (incl. custom range).
9. **Group by image** clusters visually-identical infographics; **Discover trends** clusters
   topically-similar posts. Both respect their threshold sliders.
10. No network calls to Vercel or Supabase anywhere. Only Apify + Voyage (+ optional Anthropic),
    each using the **user's own** keys.
11. **Layer 6 (§11.6):** the scrape-history table populates from `scrape_jobs`; per-market keyword
    sets persist and prefill Manual Scrape.

---

## 16. Deferred (post-v1)

- **Image descriptions (Claude vision):** ship OFF in v1 (image *embeddings* ON, Claude *descriptions*
  OFF — §7.4). Turning descriptions ON is a v1.1 enrichment; the enrich job already supports it.
- **Local scheduler / auto-scrape:** out of scope (N4). All scraping is manual (§11.5 Manual Scrape) —
  there is no `node-cron` or "scrape weekly" toggle.
- **`sqlite-vec` extension:** only if in-JS cosine over the 400-candidate cap ever becomes a
  bottleneck (it won't at this scale) — see §3.

---

## 17. Substack + cross-platform creator view

Two related additions, layered on the existing architecture without breaking any invariant above:
(1) **Substack as a third platform**, and (2) a way to see **one person's posts across every
platform in chronological order** so you can tell what they publish each day and how they
cross-reference content between LinkedIn, Twitter/X, and Substack.

### 17.1 Substack platform

Substack is a first-class platform alongside LinkedIn and Twitter, using the same scrape → map →
dedup → enrich → x-factor pipeline. It reuses **one Apify actor for both modes**
(`brilliant_gum/substack-insights-scraper`, §6.4), exactly like Twitter.

- **`Platform`** widens to `'linkedin' | 'twitter' | 'substack'`. Every enum surface (schema comments,
  the `PLATFORMS` whitelist in `/api/posts`, badges) includes it.
- **Actor id:** `apify_substack_actor_id`, seeded default `brilliant_gum/substack-insights-scraper`,
  editable in Settings. Missing token/actor id → skip that scraper, surface a Settings prompt.
- **Input builders** (§10.2): `buildSubstackKeywordInput` (`searchQueries`), `buildSubstackCreatorInput`
  (`publicationHandles` — bare handles, NOT profile urls). Input keys (`searchQueries`,
  `publicationHandles`, `maxPostsPerPublication`, `maxSearchResults`, `dateFrom`/`dateTo`,
  `minReactions`) are from the actor's input schema.
- **Mapper** `mapApifySubstackToRow` (§10.3): id `substack-<id|slug>`; engagement maps
  `reactionCount→likes`, `commentCount→comments`, `restackCount→shares`; `coverImage` → image media.
  A **Note** record (`type:'note'`) maps to id `substack-note-<id>`, content from the note body, author
  from `handle`, and `is_repost=1` when `kind==='restack'`.
- **Full history** (§17.3): Manual Scrape's `timeframe='all'` ("All time — full history") drops the date
  bound and raises the Substack caps to the actor ceiling (500 posts + 500 notes per creator), and
  LinkedIn `postedLimit='any'` with `maxPosts=500`. It's a one-time deep backfill — expensive on Apify
  (pay-per-result) and mostly duplicates on repeat runs, so it's not the default.
- **Creator add** (§11.2): a `substack.com` url (e.g. `https://<pub>.substack.com` or
  `https://substack.com/@<handle>`) detects platform `substack`; `extractSubstackHandle` derives the
  clean handle as `author_id`. A **custom-domain** publication must be added by its `.substack.com`
  url (custom domains aren't auto-detected — documented limitation, not a bug). A **bare** `@handle` or
  word stays **Twitter** (existing behavior) — the two handle namespaces are ambiguous, so Substack is
  URL-driven. LinkedIn detection (`linkedin.com`) is checked first, then `substack.com`, then Twitter.
- **x-factor, dedup, grouping, filters** all work unchanged — a Substack post is just a `PostRow`.

### 17.2 Persona — linking a person's accounts

The `creators` table is **one row per account**. To treat "Lara Acosta on LinkedIn", "…on Substack",
and "…on X" as **one person**, each creator carries a **`persona`** key (§6.2): a normalized label.
**Accounts sharing a `persona` value are the same person.**

- **Derivation** (`lib/pure/persona.ts`, Layer 0, pure): `derivePersonaKey(name)` normalizes a display
  name to a stable key — trim credentials after the first comma, lowercase, strip diacritics, drop
  non-alphanumerics, collapse whitespace. `"Lara Acosta, PhD"` → `"lara acosta"`. Empty/none → `null`.
- **Auto by default, manual override** (§11.2 route): on add/re-add, `persona = body.persona (trimmed)
  ?? derivePersonaKey(display_name)`. So the persona is **auto-assigned from the display name** (the
  "auto-match" default) and is **also stored** as a label on the account; the user can pass an explicit
  `persona` to fix a mis-match (different name spellings, common names). The repo `COALESCE`s persona so
  a provided value wins and an omitted one preserves the existing label. Display name is auto-filled
  from an existing post by that author (§11.2), so the persona fills in once a post exists.
- Persona lives **only** on `creators` (tracked people) — keyword-surfaced one-off authors have none.

### 17.3 Seeing the cross-platform timeline (dashboard extension — no new screen)

The **existing Search dashboard** is the surface (per the build decision). Two small changes let it
show a person's whole cross-platform feed in chronological order:

- **`availableAuthors`** (§11.1) gains a `persona` field, sourced from `creators.persona` by `author_id`
  (null for non-creators), and a `platform` field (which platform the account posts on). Both join the
  same way the existing `avatar`/`isCore` fields do. It returns **one row per account** — the query
  collapses the handle-vs-display-name variants a single `author_id` accrues to the most human-looking
  name (so an account never shows as two rows).
- **Creator dropdown** (`DashboardFilterBar`) groups matching accounts into a **person** when they share
  a `persona` **or** (when no persona is set) a name-derived key (`derivePersonaKey`), so two accounts
  named "Noah West" link across platforms even before either is a tracked creator. Selecting a person
  toggles **all** of that person's `author_id`s into the existing `authors` include-list at once (person
  → set of handles). Individual accounts still select individually. Because the dropdown is search-first
  (§11.5), grouping only runs over the typed matches — it never enumerates the full author set into the
  URL (§11.1).
- With the person's handles selected + **platform** = All (or a chosen subset) + **sort = Newest**, the
  grid **is** the chronological cross-platform feed: every platform's posts for that person, newest
  first. No new endpoint, no day-bucketing table — `sort=recent` over `author_id IN (…)` already does it.

### 17.4 Multi-platform filter

`platform` (query param + `PostFilters`) accepts a **subset**, not just one value, so "Substack only" and
"Substack + LinkedIn" are both expressible. Repo `buildWhere` uses `platform IN (…)` when
`filters.platforms` is a non-empty subset; `'all'` / empty / the full set apply no platform filter.
The dashboard platform control becomes **toggle pills** (LinkedIn / Twitter / Substack); the selection
serializes to `platform=<comma list>` and unknown tokens are ignored server-side (§11.1).

### 17.5 What does NOT change (scope guard)

No new screen, no `personas` table, no automatic account-merging beyond the display-name-derived key,
no day-grouping artifact, no scheduler. Substack is a platform, persona is a column, the timeline is the
existing grid with a persona-aware creator filter. Everything else in this PRD holds verbatim.

## 18. Instagram (post scraper)

Instagram is added as a **fourth platform**, reusing the same scrape → map → dedup → enrich →
x-factor pipeline and breaking no invariant above. It starts with the **post scraper**
(`apify/instagram-post-scraper`), which pulls a profile's **photo, video, and carousel** posts (and
their captions/engagement) — **creator mode only**. Speech-to-text transcript of video posts is a
separate provider — **AssemblyAI**, see §18.1.

- **`Platform`** widens to `'linkedin' | 'twitter' | 'substack' | 'instagram'`. Every enum surface
  (schema comments, the `VALID_PLATFORMS` whitelist in `/api/posts`, the `/api/scrape` default
  platform list, filter pills, badges) includes it.
- **Actor id:** `apify_instagram_actor_id`, seeded default `apify/instagram-post-scraper`, editable in
  Settings. Each Settings actor field also links to its Apify store page. Missing token/actor id → skip
  that scraper (same as the other platforms).
- **Creator mode only (no keyword search).** The post scraper is profile-driven, so `planRuns` wires
  Instagram for `creator`/`both` runs only; a keyword-only run produces no Instagram actor run. Input
  builder `buildInstagramCreatorInput` uses `username` (accepts profile urls **or** handles) +
  `resultsLimit` (per-profile cap) + `onlyPostsNewerThan` (YYYY-MM-DD date bound, mirroring the
  LinkedIn/Substack creator date-bounding so a short timeframe doesn't re-pull old posts). Targets are
  the creators' `profile_url`s.
- **Mapper** `mapApifyInstagramToRow` (§10.3): id `instagram-<shortCode>` (falls back to `raw.id`);
  canonical url `https://www.instagram.com/p/<shortCode>/`; `likesCount→likes`,
  `commentsCount→comments`, **`shares` is always 0** (Instagram exposes no reshare count);
  `ownerUsername→author_id`, `ownerFullName→author_name`. Media (`lib/pure/media.ts`
  `extractInstagramMedia`): `type:'Video'` + `videoUrl` → video (poster = `displayUrl`); a Sidecar
  fills `images[]` → image carousel; a single-image post uses `displayUrl`.
- **Creator add** (§11.2): an `instagram.com` url detects platform `instagram`;
  `extractInstagramHandle` derives the clean username as `author_id`. Like Substack, Instagram is
  **URL-driven** — a bare `@handle`/word stays **Twitter** (ambiguous namespaces). A post/reel url
  (`/p/…`, `/reel/…`) carries no profile handle → rejected. Detection order: `linkedin.com` →
  `substack.com` → `instagram.com` → Twitter.
- **x-factor, dedup, grouping, filters, persona** all work unchanged — an Instagram post is just a
  `PostRow`, and it participates in the §17 cross-platform persona timeline like any other platform.

### 18.1 Video transcription — AssemblyAI, not Apify

Video posts get a speech-to-text `transcript` via **AssemblyAI** (`lib/assemblyai.ts`,
`jobs/transcribe.ts`). This replaced the Apify transcript actor
(`crawlerbros/instagram-transcript-scraper`); the retired `app/IgCompare.tsx` tab existed to measure
the two side by side, and AssemblyAI won on cost and on latency (per-clip results instead of one
batched actor run that returns nothing until it finishes).

- **Key:** `assemblyai_api_key`, BYO in Settings, masked like every other secret. It is the ONLY gate
  now — `POST /api/transcribe` 412s with `{ needs: ['assemblyai_api_key'] }`, and no longer requires
  an Apify token, because transcription runs no actor.
- **Input is the post's own stored `media.url`** (the direct `videoUrl` from the Instagram scrape).
  AssemblyAI downloads the audio itself; we never proxy the bytes.
- **Serial, bounded.** One clip at a time, `limit` per batch (25 from the scrape follow-on). A reel is
  seconds of audio, so a queue would be over-engineering. One clip failing never aborts the batch.

**The load-bearing constraint: Instagram CDN urls are signed and expire within days.** So the three
transcript states are not the same thing and must not be collapsed:

| Outcome | Stored `transcript` | Why |
|---|---|---|
| Speech found | the text | done |
| Transcribed, no speech (music-only reel) | `''` | leaves the queue, never re-attempted |
| **Media url expired** (`AudioUnavailableError`) | **`NULL`** | needs a **re-scrape**, not a retry |

Writing `''` on an expired url would silently drop the post from
`getVideoPostsMissingTranscript()` forever. The job counts these separately and returns
`{ transcribed, remaining, unavailable }`, logging what to do about them.

This is why `transcribeInstagramVideos` runs as a **follow-on inside `runScrape`**, immediately after
the Instagram scrape, while the urls are still live. The `/api/transcribe` route remains for draining
a batch, but it can only transcribe posts whose urls have not yet expired.

---

## 19. LinkedIn profile scraper (profile details + follower count)

A **fifth Apify integration** that scrapes a single LinkedIn **profile** (not its posts): headline,
about, experience, education, skills, location — and the two engagement numbers the research
workflow wants, **`followerCount`** and **`connectionsCount`**. Unlike every scraper in §10/§17/§18,
this one does **not** produce `PostRow`s and does **not** touch the posts/dedup/x-factor/enrich
pipeline. It stores one row per profile in a dedicated **`profiles`** table and is driven by its own
thin route + a small Settings panel. It reuses the existing `runActor` client unchanged.

- **Actor id:** `apify_profile_detail_actor_id`, seeded default `harvestapi/linkedin-profile-scraper`,
  editable in Settings (with a link to its Apify store page). Distinct from `apify_profile_actor_id`
  (`harvestapi/linkedin-profile-posts`), which scrapes a profile's **posts** — this one scrapes the
  **profile itself**. Missing token → the route 412s with `{ needs: ['apify_api_token'] }` (same gate
  shape as `/api/scrape`); missing/blank actor id → the job throws a clear error.
- **Input builder** `buildLinkedInProfileInput(queries)` → `{ queries, profileScraperMode }`. The
  actor's `queries` field accepts **either** full profile urls **or** bare public identifiers
  (`basiakubicka`); `profileScraperMode` defaults to the cheaper `'Profile details no email
  ($4 per 1k)'` tier (no email lookup — the research use case doesn't need it).
- **Mapper** `mapApifyProfileToRow` (pure, Layer 0, 100% coverage): derives the row **`id` from the
  clean `publicIdentifier`** (the slug — the same "match on the clean handle, never the url" invariant
  as posts), falling back to the slug parsed out of `linkedinUrl`; throws when neither yields an id.
  Maps `followerCount`/`connectionsCount` (default 0), `headline`, `about`, `location`, `photo`,
  `firstName`/`lastName` → `name`, and stores `experience`/`education`/`skills` as **JSON `TEXT`**
  columns (the arrays the profile-rewrite workflow reads). `raw_data` preserves the full item.
- **`profiles` table (§6.6):** `id` (clean public identifier) PRIMARY KEY, `url`, `name`, `headline`,
  `about`, `followers` INTEGER, `connections` INTEGER, `location`, `avatar_url`, `experience`/
  `education`/`skills` (JSON `TEXT`), `scraped_at` (ISO-8601 UTC), `raw_data` (JSON `TEXT`). Created by
  `CREATE TABLE IF NOT EXISTS` in `schema.sql` (fresh + legacy dbs alike; no additive-column migration
  needed for a brand-new table). Repo `profiles.repo.ts`: `upsertProfile` (INSERT … ON CONFLICT(id) DO
  UPDATE — a re-scrape refreshes the row), `getProfile(id)`, `getProfileByUrl(url)`, `listProfiles()`
  (newest `scraped_at` first).
- **Job** `jobs/scrape-profile.ts` `scrapeProfile(query)`: `runActor(actorId, buildLinkedInProfileInput([query]))`
  → take the first returned item → `mapApifyProfileToRow` → `upsertProfile` → return the row. Runs
  **synchronously** (a single profile is one fast actor run, unlike the multi-actor post scrape), so
  there is **no `scrape_jobs` row and no poll loop** — the route awaits it directly. Throws (surfaced
  as a 502 by the route) when the actor returns no profile.
- **Route** `POST /api/profile` (thin, `force-dynamic`): `rejectCrossOrigin` → token gate (412) →
  `{ query }` body → `scrapeProfile` → `{ profile }`. `GET /api/profile` returns `{ profiles }` (the
  stored history) so the panel can list previously-scraped profiles. Actor/network failure → 502
  `{ error }`.
- **UI** `ProfileScrape.tsx` (Settings screen, below Manual Scrape): a url/handle input + "Scrape
  profile" button → `apiFetch('/api/profile', POST)`; on success renders the follower + connection
  counts, headline, and about, and lists the stored profiles. A 412 shows the "add your Apify key in
  Settings" prompt (same pattern as Manual Scrape). Scraped/untrusted urls render via `safeHref`.
- **Out of scope / invariants held:** profiles are **not** posts — no entry in `posts`, no x-factor,
  no embeddings, no dedup, no persona timeline. Keys stay BYO from `settings` (never `process.env`,
  never logged). This adds a table and a route but breaks none of the §6/§8/§10 post invariants.

---

## 20. Read-only API for external agents

A stable, token-gated, **read-only** surface at `/api/v1` so an external agent (Hermes) can research
the stored corpus — search with the full filter set, group by image, cluster by content, list
creators/authors/keywords/profiles — **without any ability to scrape, enrich, write, or read keys.**

### 20.1 Invariants
- **GET-only by construction.** Every `/api/v1` route module exports **only** `GET`. No POST/PUT/
  DELETE handler may ever be added there; any other verb is a framework 405. A test asserts this
  across every v1 module — adding a mutating export breaks the build's test gate, by design.
- **One query implementation.** `/api/posts` (dashboard) and `/api/v1/posts` (agent) both call
  `runPostsQuery()` in `lib/posts-query.ts`. Filters, grouping, and response shape are shared, so
  the agent can never see a different corpus than the UI. Do not fork the filter parsing.
- **Never serialize** `embedding`, `image_embedding`, or `raw_data` — on posts or profiles. The
  shared `serializePost()` strips them; `/api/v1/profiles` strips `raw_data` explicitly.
- **No secrets, ever.** The manifest and OpenAPI documents are static descriptions. `/api/v1` has no
  settings endpoint, and `readonly_api_token` is in `SECRET_SETTING_KEYS`, so `GET /api/settings`
  masks it to `'set'`/`'unset'` like every other credential.

### 20.2 Auth
- Bearer token in `settings.readonly_api_token` (BYO storage rule, §6.4 — never `process.env`,
  never code, never logged). Managed by `scripts/api-token.mjs` (`npm run api:token`,
  `-- --show` / `--rotate` / `--revoke`).
- `lib/api-readonly.ts` `requireReadToken(req)` — the first line of every v1 handler.
  - **503** when no token is configured. **Fail closed**: an unconfigured API is off, never open.
  - **401** when the token is missing or wrong. Compared with `timingSafeEqual` on equal-length
    buffers (length mismatch short-circuits).
  - Read from `Authorization: Bearer <t>` or `x-api-key: <t>` **only**. A `?token=` query param is
    never accepted — it would leak into shell history, proxy logs, and referers.

### 20.3 Endpoints
All GET, all under `/api/v1`, all token-gated, all `force-dynamic`.

| Route | Returns |
| --- | --- |
| `/api/v1` | Manifest: every endpoint, parameter, enum, default, and what the API *cannot* do. |
| `/api/v1/openapi.json` | The same surface as an OpenAPI 3.1 document. |
| `/api/v1/stats` | `getCorpusStats()` — posts/authors/likes/date-range per platform, posts per market, enrichment counts, creator count, `lastScrapedAt`. The orienting call. |
| `/api/v1/posts` | `runPostsQuery()` — the §11.1 filter set, paginated, or `imageGroups` / `contentClusters` under `groupByImage` / `discoverTrends` (§9). Plus `q` as an alias for `keywords`. |
| `/api/v1/posts/{id}` | One serialized post (404 when absent). |
| `/api/v1/authors` | `getAvailableAuthors(filters)` — the `author_id` values to filter by. |
| `/api/v1/creators` | `listCreators({tag,platform})`. The `tier` filter was removed with the column (SCHEMA_VERSION 3). |
| `/api/v1/keywords` | `listKeywords()` grouped by market. |
| `/api/v1/profiles` | `listProfiles()` minus `raw_data`. |

`lib/openapi.ts` holds **one** endpoint table driving both the manifest and the OpenAPI document, so
the two can't drift. Filter params are defined once in `FILTER_PARAMS`.

### 20.4 Read-only server mode
`/api/v1` is read-only, but the app's own routes (`POST /api/scrape`, `/api/transcribe`, the
ig-compare actors, settings) are **unauthenticated on localhost** — anything that can reach the port
can spend Apify credits. Handing an agent a base url is documentation, not a control.

`middleware.ts`, when `READONLY_SERVER=1`, applies two rules:
1. **Every non-GET request is refused with 403**, whatever the path. Airtight because **every
   side-effecting route in this app is POST/PUT/DELETE and every GET route only reads** — a rule that
   must hold for any new route.
2. **Only `/api/v1` is served**; every other path (the UI, `/api/posts`, `/api/creators`,
   `/api/settings`) is 403. Deny-by-default, so path-normalization tricks fail closed. Without this
   the bearer token would gate nothing, since the app's own GET routes are unauthenticated and
   return the same data — and `api:token --revoke` would revoke nothing.

Run a second instance for the agent (`npm run start:agent`, port 3100, same SQLite file; `migrate()`
sets `journal_mode = WAL` so a reader runs concurrently with the main instance's writes). With the
env var unset the middleware is inert and the normal instance behaves exactly as before.

**Still true:** both instances bind `127.0.0.1`, and on the MAIN instance the app's own GET routes
stay unauthenticated, so the token is a real boundary only on a `start:agent` instance. Do not expose
either port to a network without putting real auth in front of it.

### 20.5 Deployable snapshot
`scripts/export-snapshot.mjs` (`npm run snapshot`) builds a read-only copy of the corpus for a remote
host, so an agent that does not run on this machine can query it without exposing the laptop.

- **Schema is copied from the source db's own `sqlite_master`**, never from `schema.sql`, so a
  snapshot cannot drift from the migrations actually applied to the live database.
- **Never copied:** `posts.raw_data` / `profiles.raw_data` (315MB of 588MB, and stripped from every
  API response anyway), the whole `settings` table, and `scrape_jobs`.
- **The settings table is recreated with exactly one row:** a freshly minted `readonly_api_token`,
  distinct from the local one, so revoking either side is independent. `--token <t>` reuses an
  existing one, so a re-sync needs no agent reconfiguration.
- **A host with no API keys cannot scrape even in principle** — that, plus `READONLY_SERVER=1`, is
  why the remote copy is safe to run unattended.
- The script **refuses to write** a snapshot that still carries `raw_data` or any extra setting.
- Deployment runbook: `docs/deploy-vps.md`. Bind the remote instance to `127.0.0.1` so only processes
  on that host can reach it.

### 20.6 Separate build directory for the agent server
`next.config.js` sets `distDir: process.env.NEXT_DIST_DIR || '.next'`, and the agent scripts build
into `.next-agent`.

`next dev` — required to scrape, since the dashboard is the only way to launch a scrape — rewrites
`.next` as a DEVELOPMENT build with no `BUILD_ID`. `next start` then fails with "Could not find a
production build", so simply opening the dashboard silently broke the agent server. Separate
directories let the dashboard and the read-only agent server run simultaneously without clobbering
each other. `start:agent` / `start:snapshot` also build first, so a stale agent build can't be
served after a code change.

---

## 21. Daily follower tracking & the champion leaderboard

A **time series** of every core LinkedIn creator's follower count, captured once a day, turned into
two ranked boards (most followers gained, fastest % growth) and a per-creator day-by-day view that
ties a day's growth to the post published that day.

`profiles` (§6.6) already stores a follower count, but `upsertProfile` OVERWRITES it on every
re-scrape — it answers "how many followers now?" and can never answer "how many yesterday?". §21
adds the history alongside it; §6.6 is untouched.

**LinkedIn only in v1.** Twitter post payloads already carry `author.followers` for free and are the
obvious next platform, but no capture path is built for them yet. Instagram and Substack expose no
follower count in their post payloads at all.

### 21.1 Invariants
- **The gap is measured from `captured_at`, never from the day key.** A 06:00 capture followed by an
  18:00 one covers 1.5 days of real growth; differencing the `YYYY-MM-DD` strings would call that one
  day and report a 50% overstated daily rate.
- **A missing delta is `null`, never `0`.** A creator captured once has not "grown by zero" — the
  number does not exist. Collapsing the two puts brand-new creators in a dead heat with genuinely
  flat ones. The UI renders an em dash and sorts them last, below even the worst loser.
- **A follower count of 0 is never stored.** It means the scrape returned nothing, not an account
  with no followers. Storing it would invent a crash on the capture day and a matching spike on the
  next one.
- **The percent floor applies to the PERCENT board only** (`FOLLOWER_PERCENT_FLOOR = 10_000`). Rate
  ranking without a size floor is owned every day by whichever small account gained forty people on
  noise. Every creator still ranks on absolute gain, and the board states the floor on screen so an
  absent creator reads as "too small to rank by rate", not as a bug.
- **A day's growth is never split between posts.** One post that day owns the number; several share
  it and get no per-post figure; zero posts still show the growth (an older post catching fire, or an
  off-platform mention). A fabricated split is indistinguishable from a measurement.
- **A baseline materially older than the window is flagged `approx`,** not silently presented as that
  window's gain. Sized at `windowDays * 1.5`. This is the normal state of a freshly seeded series,
  where a 1d board's only baseline may be weeks old.
- **`(author_id, platform, captured_on)` is the primary key,** so a second capture in a day refreshes
  it rather than appending a duplicate that would read as a zero-gain day. This is what makes the
  daily job safe to re-run after a partial failure.

### 21.2 Schema — `follower_snapshots` (§6.7)
`author_id` (clean slug, matches `creators.author_id` / `posts.author_id`), `platform`, `captured_on`
(`YYYY-MM-DD` UTC), `captured_at` (ISO instant), `followers` INTEGER NOT NULL, `connections`,
`source` (`'profile-actor'` | `'post-author'` | `'seed'`). PK `(author_id, platform, captured_on)`;
index on `(platform, captured_on DESC)`.

**SCHEMA_VERSION 2** seeds the first data point of each series from `profiles` (`followers > 0`,
`ON CONFLICT DO NOTHING` — a real capture always outranks a seed), so the board has a baseline
immediately rather than after 24h.

### 21.3 Pure layer — `lib/pure/follower-growth.ts` (100% coverage)
- `dailyDeltas(snapshots)` → one delta per consecutive pair, oldest first, with `gap_days` and
  `per_day` normalized off the real instants. Negative deltas are kept: unfollows are signal.
- `windowGrowth(snapshots, { windowDays, asOf })` → the newest snapshot against the newest one at or
  before the window start, falling back to the nearest older snapshot and reporting the TRUE
  `gap_days` plus `approx`. `null` when fewer than two snapshots exist, or when the window is too
  short to contain a second measurement.
- `rankLeaderboard(entries, { percentFloor })` → `{ absolute, percent }`, 1-based ranks per board,
  ties broken by follower count then `author_id` so the board never reshuffles between loads.
- `attributeDay(gained, postsThatDay)` → `{ gained, post_count, shared, attributable_post_id }`.

### 21.4 Job — `jobs/snapshot-followers.ts`
Reuses the §19 profile-detail actor. The actor's `queries` field takes an ARRAY, so the roster goes
out in batches of 50 (67 creators = 2 runs, ~$0.27 at $4/1k) rather than one run per creator. Each
returned item also refreshes `profiles` — the actor already paid for the full detail. A failed batch
is logged and skipped, never fatal. Returns `{ captured_on, requested, captured, skipped, missing,
errors }`; `missing` makes a silent roster gap visible.

### 21.5 API
- `GET /api/followers?window=1|7|30&asOf=YYYY-MM-DD` → the full `Leaderboard`. An unsupported window
  or a malformed `asOf` is a 400, never a silent fallback to today.
- `GET /api/followers/[authorId]?days=N&asOf=…` → one creator's series + per-day attribution. An
  unknown creator is an empty series with a 200, not a 404.
- `POST /api/followers/snapshot` → runs a capture. CSRF-guarded, 412s on a missing Apify token, 502s
  on a hard misconfiguration (a failed batch is reported INSIDE a 200 result).
- One implementation, `lib/followers-query.ts`, exactly as `runPostsQuery()` is shared in §20.

### 21.6 UI
A third nav route, **Growth**. Header carries `as_of`, capture coverage (`66 of 67 creators`), a
1d/7d/30d toggle and a **Capture today** button. Two boards side by side, stacking under 420px:
*Most followers gained* (every creator, scrolling in place) and *Fastest % growth* (10,000+ only,
floor stated in the caption). Each row: rank, name, followers, signed delta, sparkline, posts in
window, best x-factor. Clicking a name opens the day-by-day panel with the post that owns each day.

### 21.7 Scheduling
The schedule lives in **launchd, never in the app** — the "no cron, no scheduler inside the app" rule
stands. `scripts/snapshot-followers.mjs` drives the real route (starting a local server first if none
is listening) rather than reimplementing the capture in plain JS, which would fork the logic and let
it drift. See `docs/follower-tracking.md`.

---

## 22. Post engagement growth (the rolling re-scrape)

§21 answers "is this creator growing?". This answers "how did **this post** grow after it was
published?" — whether engagement compounded past day one or spiked and died.

`posts` holds a post's LATEST engagement and `refreshEngagement()` overwrites it in place, so the
existing schema can say how a post is doing but never how it got there. §22 adds the curve.

### 22.1 Invariants
- **Day slots are measured from `posted_at`, not from the capture date.** Comparing two posts at
  "day 2" only means something if day 2 is two days after each was published. A post published at
  09:00 and one at 23:00 the same evening share a capture date while being a day apart in maturity.
- **A missing measurement is `null`, never `0`.** A post captured once has no curve; a post too young
  to have a day 3 renders an em dash. Zero would read as "flat", which is a different claim.
- **Negative deltas are preserved.** LinkedIn revises reaction counts downward (deleted accounts,
  removed reactions). Clamping to 0 would draw a flat line where the data moved.
- **PK `(post_id, captured_on)`** — a second run in a day refreshes rather than appending a phantom
  zero-gain step, which is what makes a retry safe.
- **A post returned but not stored is INSERTED, not discarded.** We already paid for the item;
  dropping it would leave a hole the search can never fill. The first real run found **58** such posts.

### 22.2 Cost — the reason this job is different
The actor bills **per result item** ($0.002/post, FREE/BRONZE; $0.00175 SILVER; $0.0015 GOLD+), so a
rolling window pays again for every post it re-reads. That is inherent — a curve cannot be measured
without re-measuring — which makes the WINDOW the only cost lever. `refreshRecentEngagement` returns
`cost_usd` so a run is never a surprise on the invoice.

The actor's `postedLimit` enum offers `any|1h|24h|week|month|3months|6months|year` — **no 2- or 3-day
option**. So the rolling window is `week` (`ENGAGEMENT_REFRESH_TIMEFRAME`) and the day-N comparison is
done over `post_snapshots`, not by asking the actor for a narrower window.

Measured on the first real run: 55 creators → **538 posts, $1.08, 53s** ≈ **$32/month**.

### 22.3 Schema — `post_snapshots` (§6.8)
`post_id`, `captured_on` (`YYYY-MM-DD` UTC), `captured_at` (ISO instant), `likes`, `comments`,
`shares`. PK `(post_id, captured_on)`; index on `captured_on DESC`. **No FK to `posts`** — the
snapshot pipeline must never be able to block a post insert, and an orphan row simply never joins.

### 22.4 Pure layer — `lib/pure/post-growth.ts` (100% coverage)
- `engagementDeltas(snapshots)` → per-step `gained`, `weighted_gained` (the §8 1/3/5 weighting), and
  `pct_of_total`.
- `summarizePostGrowth(postedAt, snapshots)` → `day1`/`day2`/`day3` filled from the capture NEAREST
  each age (half-day tolerance, so a drifting capture hour still fills its slot but a two-day gap
  never masquerades as the missing day), plus `still_climbing` and `pct_after_day1`.
- `ageInDays(from, to)` → elapsed days to one decimal, clamped at 0.

`pct_after_day1` is the signal worth reading: two posts can finish on the same total, one having
taken it all in an afternoon and the other compounding for three days. Only the second is a
repeatable format.

### 22.5 Job / API / UI
- `jobs/refresh-engagement.ts` `refreshRecentEngagement()` — batches of 25 creators, one actor run
  each; updates `posts` in place AND appends to `post_snapshots`; a failed batch is logged and
  skipped, never fatal.
- `GET /api/post-growth?days=&asOf=&authorId=` — the recent list, or one creator plus their own
  **median day-1** yardstick. `POST /api/post-growth/refresh` — CSRF-guarded, token-gated, returns
  the run cost.
- `lib/post-growth-query.ts` is the single implementation, as `runPostsQuery()` is for §20.
- `PostGrowthBoard` sits under the champion leaderboard in the Growth tab: day 1 / day 2 / day 3 /
  now / +today / % late, sorted by what moved most in the latest step.

### 22.6 Scheduling
Same rule as §21: the schedule lives in **launchd, never in the app**.
`scripts/refresh-engagement.mjs` drives the real route rather than reimplementing the job.
See `docs/post-growth-tracking.md`.
