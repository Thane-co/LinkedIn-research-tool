# Viral Post Research Tool — Project Context for Claude Code

> When you scaffold the standalone project, copy this file to the new repo root as `CLAUDE.md`.
> It is loaded every turn — keep it tight and high-signal. It holds the rules that must hold
> across **every** task. The **PRD** holds the spec (what to build, per task).

---

## What this is
A **single-user, fully-local** desktop research tool for finding viral social posts. It scrapes
LinkedIn + Twitter/X (by keyword and/or creator) via Apify, stores everything in local **SQLite**,
enriches posts with **embeddings** + an **x-factor** score, and shows them in a filterable UI
(x-factor, platform, time horizon, engagement, keyword, creator) with on-demand **image grouping**
and **content clustering**. No Vercel, no Supabase. Only external calls: Apify + Voyage + AssemblyAI
(+ optional Anthropic), all with the **user's own** keys.

## Source of truth
- **`docs/prd-research-tool.md` is the source of truth** for schema, algorithms, thresholds, and
  build order. Read the relevant PRD section before implementing.
- **If code and the PRD disagree on a name or value, the PRD wins** — fix the code to match, or
  update the PRD if the code is correct. Never silently paper over the drift.

---

## Commands
> **On a fresh build** (only this file + the PRD present), first scaffold a local
> **Next.js 14 (App Router) + TypeScript strict + Vitest + better-sqlite3** project per PRD §3/§5.
> Once scaffolded, these are the everyday commands:
- `npm run dev` — run the app locally (`next dev`); DB auto-migrates on first run (PRD §15).
- `npm run build` / `npm start` — production build / serve locally.
- `npm test` — full Vitest suite.
- `npm test -- <path>` — run one test file, e.g. `npm test -- tests/unit/pure/x-factor.test.ts`.
- `npm test -- -t "<name>"` — run tests matching a name.
- `npm run test:coverage` — coverage report (thresholds below must pass).
- `npx tsc --noEmit` — typecheck under strict mode (must be clean; no `any`).
- `npm run api:token` — create/show the read-only API bearer token (`-- --show|--rotate|--revoke`).
- `npm run start:agent` — read-only instance (`READONLY_SERVER=1`, port 3100) for external agents.

Wire these into `package.json` when scaffolding if the names differ. Work **bottom-up by layer**
(PRD §12): keep each layer's tests green before starting the next.

---

## Hard rules (non-negotiable)
- **TDD, always.** Write the failing test first → minimal impl → refactor. **Never edit a test to
  make it pass.** If a test seems genuinely wrong, stop and ask first, with the reason.
- **No secrets in code.** API keys are bring-your-own, read from the `settings` table via
  `getSettings()` — never from `process.env`, never hardcoded, **never logged**.
- **Local-only.** Never reintroduce Supabase, Postgres, Vercel, pgvector, or cron. SQLite only;
  vectors stored as Float32 **BLOBs**; cosine similarity computed **in JS** — on the ≤400 candidate
  set for clustering (§9.1–9.4), and by full scan of the cached index for retrieval (§9.5).
- **TypeScript strict, no `any`.**
- **No silent failures.** Catch and log meaningful info (posts scraped, new vs duplicate, groups
  found). Non-fatal jobs (enrich, x-factor recompute) log errors but never abort the scrape.

---

## Architecture discipline
- **Build bottom-up by dependency layer** (PRD §12): Layer 0 pure logic → 1 config/types →
  2 db + adapters → 3 jobs → 4 API routes → 5 UI. **Do not start a layer until the one below is green.**
- **A module never imports from a higher layer.** Dependencies point downward only.
- **`/lib/pure/*` has zero I/O** — pure functions, unit-tested in isolation.
- **API routes stay thin** — no business logic in routes; it lives in `/jobs` and `/lib`.
- Adapters (`apify.ts`, `voyage.ts`, `anthropic.ts`) read keys + actor ids from `settings`, then
  do their one job.

---

## Invariants — DO NOT silently re-derive
These are load-bearing decisions. **Changing any of them requires updating its test AND the PRD in
the same change.**

- **X-factor:** `weighted_score = likes·1 + comments·3 + shares·5`; baseline = mean weighted_score
  of the same author's posts in the prior **30 days**; needs **≥3** priors or x_factor is null.
- **Match on `author_id` (clean slug/handle), NEVER on `author_url`** — profile urls carry
  `?miniProfileUrn=…` query strings that break equality.
- **Derive a post's `id` from the canonical URL's activity URN, NOT `raw.id`** — `raw.id` can be a
  feed-event URN. Regex: `(?:activity|ugcPost|share)[-:](\d+)`.
- **Tweet ids are prefixed `tweet-`** to avoid collision with LinkedIn ids.
- **Instagram video transcripts come from AssemblyAI, never Apify** (§18.1). Its input is the post's
  stored `media.url`, and Instagram signs those urls so they expire in days — which is why the job
  runs as a follow-on right after the scrape. An expired url leaves `transcript` **NULL** (re-scrape
  it); only a clip that genuinely had no speech is stored as `''` (never re-attempted). Collapsing
  those two states drops the post from the queue forever.
- **Comments are scraped for the owner's own posts ONLY** (§23). A post qualifies only when its
  stored `author_id` equals the `own_linkedin_author_id` setting. The job refuses any other post, and
  any post id it has never stored, before the actor is called, and drops a returned comment whose post
  was not requested. Never widen this to creator or keyword posts.
- **Twitter uses ONE actor (`apidojo/tweet-scraper`) for both modes** — keyword passes
  `searchTerms`, creator passes `twitterHandles`; only the input shape differs.
- **The Twitter likes floor (`minimumFavorites`) applies to KEYWORD runs only** (§11.8). X filters on
  it before Apify bills, so it makes a keyword run cheaper AND sharper — but on a creator run it would
  hide that creator's weak posts, inflating the x-factor baseline (the mean of their own prior posts)
  and corrupting every score.
- **Per-platform scrape settings live in ONE `scrape_prefs` settings row** as JSON keyed by platform
  (§11.8). `parseScrapePrefs` is the only place that shape is defined; it never throws and never
  leaves a platform undefined. Instagram can never have `keywords: true` — its actor is profile-only.
- **Keyword search goes through `posts_fts` (FTS5), never `content LIKE`** (§6.1.1). The tokenizer
  `porter unicode61` is load-bearing: changing it (or the indexed columns) invalidates the index, so
  bump `SCHEMA_VERSION` in `db.ts` in the same change or searches silently go stale. User terms are
  **always quoted** by `lib/pure/fts-query.ts` — FTS5 operator syntax a user typed is searched for,
  never executed. A keyword with no indexable token matches **nothing**, never everything.
- **Clustering constants:** image similarity `0.80` · content `0.65` · content floor `0.60` ·
  text/image weight `0.75/0.25` · min group size `2` · candidate cap `400`.
- **Embeddings:** text `voyage-3`, image `voyage-multimodal-3`, both **1024-dim**, batch **100**;
  **never re-embed** a post that already has an embedding unless `reEmbed` is set. `input_type` is
  left **UNSET** everywhere (stored vectors and query vectors alike). Query and document vectors must
  come from the SAME model and input_type or cosine between them is noise — so changing the model
  means re-embedding all ~89k posts, never just the new ones.
- **Image embedding SENDS THE BYTES, never the url** (§7.3). Voyage's server-side fetcher is blocked
  by LinkedIn's CDN — it returns 400 "the image URL you have provided is invalid" even for urls that
  are signed, unexpired, and serve a 200 to us. `embedImage` therefore downloads the image itself
  (http(s) only, content-type checked, ≤`MAX_IMAGE_BYTES`) and posts `image_base64`. Reverting to
  `image_url` silently embeds nothing from LinkedIn.
- **LinkedIn image urls expire.** They carry `?e=<unix-seconds>&t=<sig>`; past that they are a
  permanent 403 and only a re-scrape mints a new one. Embed images at scrape time — a backfill run
  months later recovers nothing.
- **Semantic retrieval is an enhancement, never a dependency** (§9.5). A missing Voyage key or a
  failed embed call returns keyword results plus a `warnings` entry — never a 5xx. Hard filters
  (platform/engagement/x-factor/timeframe) shape the candidate pool BEFORE either retriever ranks,
  never after. `resetVectorIndex()` after any embedding write, or new posts stay unsearchable until
  the process restarts.
- **`/api/v1` is GET-only, forever** (§20). Every v1 route module exports **only** `GET`; a test
  asserts no mutating export exists. Never serialize `embedding`, `image_embedding`, or `raw_data`.
- **`/api/posts` and `/api/v1/posts` share `runPostsQuery()`** (`lib/posts-query.ts`) — one filter
  implementation for the dashboard and the agent API. Don't fork the parsing.
- **Every side-effecting route must be POST/PUT/DELETE; every GET route must only read.** The
  read-only server mode (`middleware.ts`, §20.4) blocks non-GET wholesale and relies on this.

---

## Coverage
- ≥ **80%** lines/functions/branches globally.
- **100%** on the pure modules: `x-factor.ts`, `dedup.ts`, `mappers.ts`, `similarity.ts`,
  `image-groups.ts`, `content-clusters.ts`, `vector-blob.ts`, `vector-search.ts`, `fts-query.ts`.
  A silent failure in these corrupts data.

---

## Testing conventions
- **Mock all external HTTP** (Apify, Voyage, Anthropic) with msw. Never hit real APIs in tests.
- **DB tests use a real `:memory:` SQLite** (not a mock) so schema + queries are exercised for real.
- **Component tests run under jsdom** (`// @vitest-environment jsdom`) with `@testing-library/react`;
  logic/db/route tests stay on `node`. `app/*.tsx` is outside the coverage `include` — behaviour is
  asserted by component tests, not line counts (PRD §13).
- Keep similarity/clustering functions **dimension-agnostic** so tests can use tiny 4-dim vectors.
- Fixtures under `/tests/fixtures`: one Apify LinkedIn item, one tweet, one Voyage response, and a
  few hand-built vectors.

---

## What NOT to build (scope guard)
This is the *research* half only. **Out of scope — do not add:** post generation / drafts, voice
profiles, a stored `trends`/`trend_posts` table, a Claude trend-clustering job, cron / scheduling,
auth, multi-user, or billing. Grouping is a **live on-demand embedding view**, not a persisted
artifact. (In scope, and not to be confused with the above: the saved `keywords` and read-only
scrape history — PRD §11.6.) If a task seems to need something out of scope, stop and confirm — it's
probably scope creep.

---

## Coding standards
- All API routes return `NextResponse.json()`.
- **Client components fetch through `apiFetch()` (`lib/api-client.ts`), never bare `fetch`.** It throws
  an `ApiError` on non-2xx/network/malformed responses; the component catches it and renders an error
  state (`role="alert"`). A bare `setState(await res.json())` is a silent failure — never write one.
- **Local security posture (unauthenticated localhost server).** The dev/start server binds to
  `127.0.0.1` (loopback, not the LAN). **Every mutating route handler calls `rejectCrossOrigin(req)`
  first** (`lib/api-guard.ts`, CSRF guard). Render scraped/untrusted urls as hrefs only via
  **`safeHref`** (`lib/pure/url.ts`) — `http(s)` only. Keep all three when adding routes/links.
- **Every route handler that reads or writes the DB exports `export const dynamic = 'force-dynamic'`**
  — App-Router prerenders handlers by default, which would freeze DB reads (e.g. settings readiness)
  at build time (PRD §11/§14).
- No inline SQL scattered around — keep queries in the `/lib/db/*.repo.ts` modules.
- Async/await throughout, no raw Promise chains.
- Store timestamps as **ISO-8601 UTC strings** so lexicographic order == chronological order.
- Booleans in SQLite are `INTEGER` 0/1; JSON columns are stringified `TEXT`.

## Styling
- **Follow the design system in PRD §11.7** — it holds across the whole app. One global stylesheet
  (`app/globals.css`) defines the design **tokens**; components emit **semantic classNames** and the
  stylesheet targets them. No CSS framework, no CSS-in-JS, no inline hex/spacing — add or reuse a
  token, never scatter raw values. (The token table + wireframes live in the PRD, not here.)
