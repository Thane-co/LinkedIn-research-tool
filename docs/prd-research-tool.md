# PRD — Viral Post Research Tool (Local, Standalone)

**Status:** Draft for build
**Author:** Basia Kubicka
**Last updated:** 2026-06-30
**Audience:** Claude Code (this document is the single source of truth to rebuild the product from scratch)

---

## 0. How to read this document

This PRD is written so that a fresh Claude Code session can build the entire product. Every number, formula, model name,
threshold, column, and index is specified explicitly. Where the original app made a
decision, the decision and its rationale are recorded so they are not silently re-derived.

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
| Runtime / UI | **Next.js 14 (App Router), run locally** (`next dev` / `next start`) | The original is already Next.js 14; routes & React components port ~1:1. Easiest + cheapest path. |
| Language | **TypeScript, strict mode, no `any`** | Matches original standards. |
| Database | **SQLite** via **`better-sqlite3`** | Embedded, synchronous, zero-config, single file. Fast for local single-user. |
| Vector storage | Embeddings stored as **BLOB (Float32, 1024 dims)** in SQLite | No pgvector / no native vector extension. |
| Vector search | **In-JS cosine similarity** over a capped candidate set (≤400) | Mirrors original legacy JS clustering path; O(n²) on ≤400 is trivial. `sqlite-vec` is an optional future optimization, **not** required for v1. |
| Scraping | **Apify** (`apify-client`) | Accepted external dependency. |
| Text embeddings | **Voyage `voyage-3`** (1024-dim) via `https://api.voyageai.com/v1/embeddings` | Accepted external dependency; same model as original. |
| Image embeddings | **Voyage `voyage-multimodal-3`** (1024-dim) via `https://api.voyageai.com/v1/multimodalembeddings` | Same as original. |
| Image description (optional) | **Anthropic Claude vision** (`claude-sonnet-4-6`) | Optional enrichment; see §7.4. Can be deferred. |
| Testing | **Vitest** + `@vitest/coverage-v8` | Matches original. |
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
    /api
      /posts/route.ts            ← GET posts (filter/paginate/group)         (Layer 4)
      /creators/route.ts         ← GET/POST/DELETE creators                  (Layer 4)
      /scrape/route.ts           ← POST start scrape                         (Layer 4)
      /scrape/[id]/route.ts      ← GET scrape job status                     (Layer 4)
      /settings/route.ts         ← GET/PUT BYO keys + actor ids              (Layer 4)
      /settings/test/route.ts    ← POST per-provider connection test         (Layer 4)
    /page.tsx                    ← dashboard                                 (Layer 5)
    /DashboardClient.tsx
    /DashboardFilterBar.tsx
    /PostCard.tsx
    /CreatorManager.tsx
    /SettingsPanel.tsx           ← onboarding / key entry + connection tests (Layer 5)
  /tests
    /setup.ts
    /fixtures/{apify,voyage,posts}.ts
    /unit/pure/*.test.ts
    /unit/db/*.test.ts
    /unit/jobs/*.test.ts
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
  market            TEXT,                      -- free-text segment label, e.g. 'ai'

  -- enrichment (nullable until enrich job runs)
  embedding         BLOB,                      -- Float32[1024] of content (+image desc)
  image_url         TEXT,                      -- best post image url (may expire)
  image_description TEXT,                      -- optional Claude-vision description
  image_embedding   BLOB,                      -- Float32[1024] of image
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
  tier          TEXT NOT NULL DEFAULT 'watch', -- 'core' | 'watch' (controls who the creator-scraper pulls)
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  market        TEXT NOT NULL DEFAULT 'ai',
  notes         TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(profile_url)
);
CREATE INDEX IF NOT EXISTS creators_tier_idx ON creators(tier);
```

> **Tier semantics (simplified from original):** `tier` only controls **who the creator
> scraper pulls** (it pulls `tier = 'core'`). It does **not** gate x-factor. X-factor is
> computed for **any** post whose author has ≥3 prior posts in the DB within the window
> (§8.3) — this removes the original's core-tier coupling and is simpler/correct.

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
  stored wins). So the non-secret defaults are always present even against an unseeded db — the
  migrate-time seed and the read-time merge are belt-and-suspenders. `getKey(name)` returns
  `undefined` for an unset **or** empty/cleared value.
- All adapters (`apify.ts`, `voyage.ts`, `anthropic.ts`) read keys via `getSettings()`/`getKey()`,
  never from `process.env`.
- If a **required** key for an action is missing, the API route returns a clear `409`/`412`
  ("Add your Apify token in Settings") and the UI routes the user to the Settings panel —
  scraping/embedding is disabled until keys are present.
- **At-rest note:** keys are stored as plaintext in the local SQLite file (acceptable for a
  single-user local tool — same trust boundary as the user's own disk). OS-keychain storage
  is a possible v1.1 hardening, **not** required for v1. Never log key values.

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
  (`getUnembedded(limit, { reEmbed })`) filters on `embedding IS NULL` by default and drops that
  filter under `reEmbed`.

**Enrich contract** (`enrichPosts(limit, { reEmbed? }) → { embedded, remaining }`, Layer 3):
- Load ≤`limit` candidates, build each embedding text (§7.2), batch-embed, write BLOBs.
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
   before `T` is **excluded** (matches §12 step 2's boundary test; resolved 2026-07-01).
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

> Optional optimization (original updated only the most-recent 30d of posts while using older
> ones purely as baseline contributors). For a local single-user DB this is unnecessary;
> updating all of an author's posts is fine and simpler. Keep it simple unless perf bites.

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
  (fallback to its content snippet); `totalLikes`, `totalShares` summed; `postIds[]`.
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
- Per cluster: `label`, `totalLikes`, `totalShares`, `postIds[]`; sort by total engagement DESC.

> These mirror the original `lib/image-groups.ts` / `lib/content-clusters.ts` exactly.
> No Claude, no pgvector — pure functions, fully unit-testable with small fixture vectors.

---

## 10. Scraping specification

### 10.1 Apify actors

**Three actors total** (confirmed from the original project's `.env.local`). Default ids are
seeded in the `settings` table (§6.4) and are editable in the Settings UI; the **API token**
is the user's own (BYO):

| settings key | default actor | platform / mode |
|---|---|---|
| `apify_keyword_actor_id` | `harvestapi/linkedin-post-search` | LinkedIn — keyword search |
| `apify_profile_actor_id` | `harvestapi/linkedin-profile-posts` | LinkedIn — creator/profile |
| `apify_tweet_actor_id` | `apidojo/tweet-scraper` | **Twitter — BOTH keyword & creator** |

> **Twitter uses ONE actor (`apidojo/tweet-scraper`) for both modes** — keyword search passes
> `searchTerms`, creator scrape passes `twitterHandles`; only the *input shape* differs (§10.2).
> Do not split this into two actor ids. If the Apify token or a needed actor id is empty, skip
> that scraper gracefully and surface a Settings prompt.

> **Actor-id path encoding (gotcha):** in Apify REST paths the `/` in an actor id becomes `~`
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
- `image_url` = first `raw.postImages[].url` (if any).
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
- `platform = 'twitter'`; `raw_data = JSON.stringify(raw)`.

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
  creatorIds?: string[],         // which creators to pull; defaults to every tier-'core' creator
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
  `discoverTrends`). Candidate `posts` drop their vectors too; under `groupByImage` each is annotated
  with `imageGroupSize` (its group's size, `1` if ungrouped). `groupByImage` takes precedence if both
  flags are set. `imageThreshold`/`textThreshold` override the §9.2 defaults.
- `availableAuthors` (always present) is the distinct `author_id`+`author_name`+`avatar` set for the
  creator-filter dropdown. It honors the active filters **except** the `authors` include-list (so
  selecting authors never shrinks the dropdown). The `posts` table has **no avatar column**, so
  `avatar` is sourced from `creators.avatar_url` by matching on `author_id` (null when the author
  isn't a tracked creator).

Timeframe → `posted_at >= now - N`: `24h`=1d, `3d`=3d, `week`=7d, `month`=30d, `3months`=90d.

### 11.2 `GET/POST/DELETE /api/creators`
Platform detection / url normalization / `author_id` derivation happen **at the route layer** via
`lib/pure/url.ts`; the repo is storage-only.
- `GET` (optional `?tier=&tag=&platform=`) → `{ creators, tags }` (distinct tags across all creators).
- `POST` body `{ input?: string, inputs?: string[], tier?, tags?, market?, notes? }` → add one or
  many. Each entry may itself be newline/comma-separated. For each: detect platform (a `linkedin.com`
  url → LinkedIn; a Twitter/X url or bare `@handle` → Twitter), normalize the url, and derive
  `author_id` (`extractLinkedInSlug` for `/in/`|`/company/`, `extractTwitterHandle` for Twitter).
  Auto-fill `display_name` from any existing post by that author. Entries that resolve to no valid
  url/handle are skipped; a body with **zero** valid entries → `400`. Re-adding an existing creator
  promotes `watch`→`core` (never downgrades). Returns the refreshed `{ creators, tags }`.
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
    candidates deterministically; it decodes BLOBs → `number[]` for the pure clustering fns.
    `insertPosts` uses `INSERT OR IGNORE` and returns the count actually inserted. `getUnembedded`
    filters on `embedding IS NULL` unless `reEmbed` is set; `countUnembedded` backs the enrich
    `remaining` count. `getAvailableAuthors` (§11.1) applies the filters minus the `authors` list and
    joins `creators.avatar_url` on `author_id` for the `avatar` field (posts carry no avatar column).
    *Tests:* against `:memory:` db with seeded rows — filters, pagination/`hasMore`, ordering,
    x-factor update, dedup queries, clustering-candidate decode + image-required filter,
    `reEmbed`/`countUnembedded`, available-authors distinctness + avatar join.
14. **`db/creators.repo.ts`** — surface is `upsertCreator(new)` (insert, or promote watch→core and
    fill newly-provided display fields when the `profile_url` already exists — never downgrades
    core), `listCreators(filter?)` → `{ creators, tags }` (distinct tags across ALL creators),
    `deleteCreator(id)`. Storage only — platform detection / url normalization / author_id
    derivation happen at the route layer (§11.2) via `lib/pure/url.ts`. *Tests:* insert, unique url,
    promote watch→core, no-downgrade, tag filter/extraction, delete.
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
    `fetchWithTimeout` (§10.7). *Tests:* msw-mock Voyage; batch of 100; out-of-order response
    reordered; error per-batch throws; **a hung batch aborts** via its timeout; throws when key unset.
19. **`anthropic.ts`** *(optional)* — `describeImage(url) → string | null`. Reads key from settings.
    **Contract:** returns `null` when the key is unset (feature disabled — the enrich job skips
    description); **throws** on an HTTP error so the enrich job can log it non-fatally (§7.4). Mocked.

### Layer 3 — Orchestration jobs
20. **`jobs/enrich.ts`** — `enrichPosts(limit, {reEmbed}) → { embedded, remaining }` (§7.3): load
    unembedded posts, build text, batch-embed, write BLOBs; per-image embed/describe is non-fatal and
    preserves an existing description. *Tests:* mocks repo + voyage; never re-embeds unless `reEmbed`
    (flag threads to the loader); text-only vs image post write paths; per-image failure still writes
    the text vector; `remaining` count correct.
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
    by `@handle`; auto-fill `display_name` from posts; add-many + promote watch→core; `400` on no
    valid input; list + tier/tag/platform filter; delete (and `400` without id).
24. **`/api/posts`** — paginated + grouping modes. *Tests:* each filter; sort modes; `hasMore`
    exactness; BLOBs/`raw_data` stripped; `availableAuthors` always present; `groupByImage` returns
    `imageGroups` + `imageGroupSize` annotation; `discoverTrends` returns `contentClusters`;
    400-cap respected.
25. **`/api/scrape` + `/api/scrape/[id]`** — start creates the job and returns `202 { jobId }`
    immediately (fires `runScrape` with that id, unawaited); status GET returns the row or `404`.
    *Tests:* `412 { needs }` when Apify/Voyage keys missing (lists only the still-missing ones);
    running job created + `runScrape` handed the `jobId`; `[id]` returns the row and 404s on unknown.

### Layer 5 — UI (component + light e2e)
26. **`SettingsPanel` + onboarding gate** — paste Apify token, Voyage key, optional Anthropic
    key; edit actor ids; "Test connection" per provider (green/red). On first run (no keys), the
    app opens here and gates Scrape until Apify+Voyage are set. *Tests:* save calls PUT; gate
    shows when `ready.apify`/`ready.voyage` false.
27. **`PostCard`** — render author, content (truncate/expand), engagement, platform badge,
    scrape-source badge, **x-factor badge** (≥2× green 🔥 / 0.5–2× gray / <0.5× red), image,
    group-size indicator.
28. **`DashboardFilterBar`** — keywords chips, creator dropdown (All/None + search + bulk paste),
    minLikes/minShares, **timeframe select + custom range**, **x-factor min**, platform select,
    Group-by-image toggle + threshold slider, Discover-trends toggle + threshold slider.
29. **`CreatorManager`** — list creators with tier, add (single/bulk), promote, delete.
30. **`DashboardClient`** — state, fetch `/api/posts`, render grid vs group/cluster views,
    **Scrape button** → POST `/api/scrape` → poll status pill.
31. **`page.tsx`** — compose; on mount check `/api/settings` readiness → onboarding or dashboard;
    load creators + first page.

---

## 13. Testing strategy

- **Vitest**, `environment: 'node'` for logic/db; component tests can use jsdom.
- Coverage thresholds: **lines/functions/branches ≥ 80** globally; **100%** on
  `lib/pure/x-factor.ts`, `lib/pure/dedup.ts`, `lib/pure/mappers.ts`,
  `lib/pure/similarity.ts`, `lib/pure/image-groups.ts`, `lib/pure/content-clusters.ts`,
  `lib/pure/vector-blob.ts`.
- **Never modify a test to make it pass.** Tests define behavior; fix the implementation. If a
  test genuinely must change, ask first and explain why. (Project rule.)
- Mock all external HTTP (Apify, Voyage, Anthropic) with msw. Never hit real APIs in tests.
- DB tests use `better-sqlite3` `:memory:` databases — real SQL, no mock — so schema + queries
  are exercised for real. This is the one place we test against the actual engine.
- Fixtures (`/tests/fixtures`): sample Apify LinkedIn item, Apify tweet, Voyage response, and a
  handful of tiny hand-built 1024→(use 4- or 8-dim in tests) embedding vectors for clustering.
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

---

## 15. Acceptance criteria (v1 done when…)

1. `npm run test` green; coverage thresholds met (incl. 100% on the listed pure modules).
2. From a clean machine: `npm i && npm run dev`, open localhost, DB auto-migrates on first run.
3. **First-run onboarding**: with no keys, the app opens Settings and Scrape is disabled. After
   pasting a user's own Apify + Voyage keys (and optionally Anthropic) and passing the per-
   provider connection tests, the dashboard unlocks. **No key was bundled or shipped.**
4. Add a LinkedIn creator and a Twitter creator via the UI; both persist.
5. Click **Scrape** → progress pill → new posts appear; second identical scrape inserts **0**
   new posts (dedup proven).
6. Posts show correct platform + scrape-source badges; x-factor badges appear for authors with
   ≥3 prior posts in window.
7. Filters work and compose: platform, keywords, creators, min likes/shares, **min x-factor**,
   and **time horizon** (incl. custom range).
8. **Group by image** clusters visually-identical infographics; **Discover trends** clusters
   topically-similar posts. Both respect their threshold sliders.
9. No network calls to Vercel or Supabase anywhere. Only Apify + Voyage (+ optional Anthropic),
   each using the **user's own** keys.

---

## 16. Open questions / deferred

- Q1 — ~~Twitter actor ids~~ **RESOLVED.** Confirmed from the original `.env.local`: three
  actors — LinkedIn keyword `harvestapi/linkedin-post-search`, LinkedIn profile
  `harvestapi/linkedin-profile-posts`, and Twitter `apidojo/tweet-scraper` (one actor, both
  search & profile modes). Seeded as editable defaults in `settings` (§6.4); the API token is BYO.
- Q2 — Image descriptions (Claude vision): ship OFF in v1.0, ON in v1.1? (Recommendation: image
  *embeddings* ON, *descriptions* OFF for v1.)
- Q3 — Local scheduler (e.g. a "scrape weekly" toggle backed by `node-cron`): deferred (N4).
- Q4 — `sqlite-vec` extension: only if in-JS cosine on 400 candidates ever becomes a bottleneck
  (it won't at this scale).
```
