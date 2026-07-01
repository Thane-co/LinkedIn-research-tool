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
and **content clustering**. No Vercel, no Supabase. Only external calls: Apify + Voyage (+ optional
Anthropic), all with the **user's own** keys.

## Source of truth
- **`docs/prd-research-tool.md` is the source of truth** for schema, algorithms, thresholds, and
  build order. Read the relevant PRD section before implementing.
- **If code and the PRD disagree on a name or value, the PRD wins** — fix the code to match, or
  update the PRD if the code is correct. Never silently paper over the drift.

---

## Commands
> The app is **not scaffolded yet** — only this file and the PRD exist. Scaffold as a local
> **Next.js 14 (App Router) + TypeScript strict + Vitest + better-sqlite3** project per PRD §3/§5,
> then these are the everyday commands:
- `npm run dev` — run the app locally (`next dev`); DB auto-migrates on first run (PRD §15).
- `npm run build` / `npm start` — production build / serve locally.
- `npm test` — full Vitest suite.
- `npm test -- <path>` — run one test file, e.g. `npm test -- tests/unit/pure/x-factor.test.ts`.
- `npm test -- -t "<name>"` — run tests matching a name.
- `npm run test:coverage` — coverage report (thresholds below must pass).
- `npx tsc --noEmit` — typecheck under strict mode (must be clean; no `any`).

Wire these into `package.json` when scaffolding if the names differ. Work **bottom-up by layer**
(PRD §12): keep each layer's tests green before starting the next.

---

## Hard rules (non-negotiable)
- **TDD, always.** Write the failing test first → minimal impl → refactor. **Never edit a test to
  make it pass.** If a test seems genuinely wrong, stop and ask first, with the reason.
- **No secrets in code.** API keys are bring-your-own, read from the `settings` table via
  `getSettings()` — never from `process.env`, never hardcoded, **never logged**.
- **Local-only.** Never reintroduce Supabase, Postgres, Vercel, pgvector, or cron. SQLite only;
  vectors stored as Float32 **BLOBs**; cosine similarity computed **in JS** on the ≤400 candidate set.
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
These are load-bearing decisions (several are already-paid-for bug fixes). **Changing any of them
requires updating its test AND the PRD in the same change.**

- **X-factor:** `weighted_score = likes·1 + comments·3 + shares·5`; baseline = mean weighted_score
  of the same author's posts in the prior **30 days**; needs **≥3** priors or x_factor is null.
- **Match on `author_id` (clean slug/handle), NEVER on `author_url`** — profile urls carry
  `?miniProfileUrn=…` query strings that break equality.
- **Derive a post's `id` from the canonical URL's activity URN, NOT `raw.id`** — `raw.id` can be a
  feed-event URN. Regex: `(?:activity|ugcPost|share)[-:](\d+)`.
- **Tweet ids are prefixed `tweet-`** to avoid collision with LinkedIn ids.
- **Twitter uses ONE actor (`apidojo/tweet-scraper`) for both modes** — keyword passes
  `searchTerms`, creator passes `twitterHandles`; only the input shape differs.
- **Clustering constants:** image similarity `0.80` · content `0.65` · content floor `0.60` ·
  text/image weight `0.75/0.25` · min group size `2` · candidate cap `400`.
- **Embeddings:** text `voyage-3`, image `voyage-multimodal-3`, both **1024-dim**, batch **100**;
  **never re-embed** a post that already has an embedding unless `reEmbed` is set.

---

## Coverage
- ≥ **80%** lines/functions/branches globally.
- **100%** on the pure modules: `x-factor.ts`, `dedup.ts`, `mappers.ts`, `similarity.ts`,
  `image-groups.ts`, `content-clusters.ts`, `vector-blob.ts`. A silent failure in these corrupts data.

---

## Testing conventions
- **Mock all external HTTP** (Apify, Voyage, Anthropic) with msw. Never hit real APIs in tests.
- **DB tests use a real `:memory:` SQLite** (not a mock) so schema + queries are exercised for real.
- Keep similarity/clustering functions **dimension-agnostic** so tests can use tiny 4-dim vectors.
- Fixtures under `/tests/fixtures`: one Apify LinkedIn item, one tweet, one Voyage response, and a
  few hand-built vectors.

---

## What NOT to build (scope guard)
This is the *research* half only. Do **not** add (they were deliberately stripped):
post generation / drafts, voice profiles, a stored `trends`/`trend_posts` table, the Claude
trend-clustering job, cron / scheduling, auth, multi-user, or billing. Grouping is a **live
on-demand embedding view**, not a persisted artifact. If a task seems to need one of these, stop
and confirm — it's probably scope creep.

---

## Coding standards
- All API routes return `NextResponse.json()`.
- No inline SQL scattered around — keep queries in the `/lib/db/*.repo.ts` modules.
- Async/await throughout, no raw Promise chains.
- Store timestamps as **ISO-8601 UTC strings** so lexicographic order == chronological order.
- Booleans in SQLite are `INTEGER` 0/1; JSON columns are stringified `TEXT`.
