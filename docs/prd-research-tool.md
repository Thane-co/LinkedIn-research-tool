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
It scrapes posts from **LinkedIn and Twitter/X** (by keyword and/or by creator) via
Apify, stores them in a local **SQLite** database, enriches them with **embeddings**
(text + image) and an **x-factor** performance score, and presents them in a filterable
UI where the user can:

- Filter by **x-factor** (overperformance multiplier) and sort by it
- Filter by **platform** (LinkedIn / Twitter / both)
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

### 6.2 `creators`

```sql
CREATE TABLE IF NOT EXISTS creators (
  id            TEXT PRIMARY KEY,              -- uuid-ish; generate with crypto.randomUUID()
  platform      TEXT NOT NULL,                 -- 'linkedin' | 'twitter'
  profile_url   TEXT NOT NULL,                 -- normalized profile url (LinkedIn) or https://x.com/<handle>
  author_id     TEXT,                          -- clean slug/handle for x-factor matching
  display_name  TEXT,
  avatar_url    TEXT,
  tier          TEXT NOT NULL DEFAULT 'core',  -- every creator is 'core' (the scrape set); retained for that filter
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  market        TEXT NOT NULL DEFAULT 'ai',
  notes         TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(profile_url)
);
CREATE INDEX IF NOT EXISTS creators_tier_idx ON creators(tier);
```

> **One creator list (no watch/core split in v1):** every creator is part of the scrape set —
> `tier` defaults to `'core'` and the UI never sets anything else, so the creator list *is* the set
> a creator/both scrape pulls. The column is retained only so the scraper can filter the set; it does
> **not** gate x-factor. X-factor is computed for **any** post whose author has ≥3 prior posts in the
> DB within the window (§8.3).

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

## 10. Scraping specification

### 10.1 Apify actors

**Three actors total.** Default ids are seeded in the `settings` table (§6.4) and are editable in the
Settings UI; the **API token** is the user's own (BYO):

| settings key | default actor | platform / mode |
|---|---|---|
| `apify_keyword_actor_id` | `harvestapi/linkedin-post-search` | LinkedIn — keyword search |
| `apify_profile_actor_id` | `harvestapi/linkedin-profile-posts` | LinkedIn — creator/profile |
| `apify_tweet_actor_id` | `apidojo/tweet-scraper` | **Twitter — BOTH keyword & creator** |

> **Twitter uses ONE actor (`apidojo/tweet-scraper`) for both modes** — keyword search passes
> `searchTerms`, creator scrape passes `twitterHandles`; only the *input shape* differs (§10.2).
> Do not split this into two actor ids. If the Apify token or a needed actor id is empty, skip
> that scraper gracefully and surface a Settings prompt.

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
{ profileUrls: string[], maxPostsPerProfile: <10–100 by timeframe>, sortBy: 'date' }
```
**Twitter keyword:**
```ts
{ searchTerms: string[], maxItems: 200, sort: 'Top',
  minimumFavorites?: number, start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD', tweetLanguage?: string }
```
**Twitter creator:**
```ts
{ twitterHandles: string[], maxItems: 50, sort: 'Latest', minimumFavorites?: number }
```

Builder function names (in `lib/apify.ts`): `buildLinkedInKeywordInput(keywords, timeframe)`,
`buildLinkedInCreatorInput(profileUrls, timeframe)`, `buildTwitterKeywordInput(keywords, opts?)`,
`buildTwitterCreatorInput(handles, opts?)`. They are pure — no I/O.

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

### 11.1 `GET /api/posts` — the main read endpoint
Query params:
```
platform=linkedin|twitter|all           (default all)
keywords=comma,separated                 (matched against content, case-insensitive LIKE)
authors=comma,separated author_ids       (include filter)
minLikes=int  minShares=int              (engagement floors; default 0)
minXFactor=float                          (x_factor >= value; null x_factor excluded)
timeframe=24h|3d|week|month|3months|custom
dateFrom=ISO  dateTo=ISO                  (when timeframe=custom)
market=string                             (posts.market bucket; §11.6, §6.5)
sort=recent|likes|xfactor                 (default recent)
groupByImage=true|false                   (default false)
discoverTrends=true|false                 (default false)
imageThreshold=float                       (default 0.80)
textThreshold=float                        (default 0.65)
page=int  pageSize=int                      (default 50, max 200)
```
Behavior:
- **Paginated mode** (default): SQL `WHERE` from filters + `ORDER BY` from `sort` + `LIMIT/OFFSET`.
  Response: `{ posts, total, page, pageSize, hasMore, availableAuthors }`, where `hasMore` is exact
  (`offset + posts.length < total`). `posts` are serialized **without** the `embedding`,
  `image_embedding`, and `raw_data` columns (never ship BLOBs/vectors over the wire).
- **Grouping mode** (`groupByImage` or `discoverTrends` true): load up to **400** filtered posts
  that carry the required embeddings, run §9 clustering in JS, and return `{ posts, hasMore:false,
  availableAuthors }` plus **`imageGroups`** (for `groupByImage`) or **`contentClusters`** (for
  `discoverTrends`). The candidate `posts` are **full serialized posts** (same shape as paginated
  mode — BLOBs/`raw_data` stripped, `media` parsed), so the UI renders each group's member cards by
  looking their `postIds` up in `posts` — group membership is shown by the panel, not per-card.
  `groupByImage` takes precedence if both flags are set. `imageThreshold`/`textThreshold` override the §9.2 defaults.
  Each group/cluster carries a `similarity` score (§9.3/§9.4); an empty `imageGroups`/`contentClusters`
  array means nothing met the threshold (the UI shows an empty-state, not a blank page).
- `availableAuthors` (always present) is the distinct `author_id`+`author_name`+`avatar` set for the
  creator-filter dropdown. It honors the active filters **except** the `authors` include-list (so
  selecting authors never shrinks the dropdown). The `posts` table has **no avatar column**, so
  `avatar` is sourced from `creators.avatar_url` by matching on `author_id` (null when the author
  isn't a tracked creator).

Timeframe → `posted_at >= now - N`: `24h`=1d, `3d`=3d, `week`=7d, `month`=30d, `3months`=90d.

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
Body: `{ platforms?, mode?, keywords?, creatorIds?, timeframe?, market? }` (defaults: all platforms,
`both`, `week`, `market` from `default_market`). `GET /api/scrape/[id]` → the live `scrape_jobs` row,
or `404` when the id is unknown.

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
│ Showing 20 of 24 matching posts                                                             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ [Keywords… ] [Creators (516) ▾] [♥ 750] [↗ 0] [✕ 0] [Newest ▾] [Last week ▾] [Framework ▾] │
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
| Creators (N) ▾ (multi-select, count = # selected/available) | `authors` |
| ♥ number | `minLikes` |
| ↗ number | `minShares` |
| ✕ number | `minXFactor` |
| Newest ▾ (Newest / Most liked / Highest x-factor) | `sort` |
| Last week ▾ (24h/3d/week/month/3months/custom) | `timeframe` (+ `dateFrom`/`dateTo`) |
| Framework ▾ (market) | `market` *(§11.6)* |
| LinkedIn ✕ (platform pill; ✕ clears to All) | `platform` |
| Search | re-fetch |

Post card header: avatar + author + **posted date** on the left; a **🔗 link to the original post**
(opens in a new tab) and the **platform** badge on the right. Body: content with **…see more** expand;
then the post's **media** by `media.type` (§10.3.1): a single **image**, a multi-image **carousel**
(horizontal strip), a **video** (poster + ▶ overlay → opens the original post; licdn streams aren't
played inline in v1), or a **document** (cover image + a `📄 N pages` badge → opens the document url).
Footer: engagement **👍 likes · 💬 comments · 🔁 shares** on the left, and on the right
the **scrape-source badge** (`both`/`creator`/`keyword`) + **x-factor badge** (≥2× green 🔥 / 0.5–2×
gray / <0.5× red / hidden when null). No selection checkbox and no add-to-creators button — creators
are managed on the Scrape Settings screen. (Group membership is shown by the group panel, not on the
card — see §11.5.)

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
> would imply a schedule (and a tier) that don't exist in the UI.

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
    `ApifyTweet`, `PostWithMedia`, `ImageGroup`, `ContentCluster`, `ScrapeStats`, `Timeframe`.
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
    (`platform`/`timeframe`/`sort`): an unknown value is **ignored**, not blindly cast — an invalid
    `timeframe` would otherwise crash the date math, a bad `platform` would silently filter out every
    row. Serialization runs the `media` JSON through **`isPostMedia`** (§10.3.1), so a valid-JSON but
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
