# Content performance loop

Two standalone scripts for the daily content loop. Both run headless (no dev server, no HTTP): they
call the existing job layer directly, so the daily cron only needs a running script. Run them on
Node 20 (`nvm use 20`), the version the repo's better-sqlite3 binary is built against.

Both scripts are unit-testable: each exports a `run()` function and keeps its
`require.main === module` invocation thin at the bottom of the file.

## 1. Viral-window rescan — `npm run scan:viral`

`scripts/scrape-viral-window.ts`

Re-scrapes the same recent window of every core LinkedIn creator daily, so a post that only blows up
30+ hours after going live still gets picked up with current engagement numbers. It drives the same
`runScrape()` pipeline the `/api/scrape` route uses (`mode: 'creator'`, `platforms: ['linkedin']`,
`timeframe: '3d'`, all core creators), then prints a short summary of the freshest LinkedIn window
(count plus the top 10 by x-factor). It writes nothing to disk; a separate downstream consumer turns
the same DB query into the actual morning brief.

- **Command:** `npm run scan:viral`
- **Env vars / args:** none. (Apify keys are read from the `settings` table, as everywhere else.)

## 2. Daily post-performance + follower attribution — `npm run post-loop:daily`

`scripts/daily-post-performance.ts`

For Basia's own posts (`author_id` `basiakubicka`) only. Re-scrapes her recent posts, snapshots
today's follower count for all core creators, then finds each of her posts in a loose T+23h window
(20 to 30 hours old) that has not already been logged today. For each one it captures the current
likes / comments / shares / x-factor, tags a performance bucket, looks up that day's follower
attribution, and appends one JSON line to the log file. It captures raw facts only: no draft text,
no edits, no skill names, and no computed lessons (that is a separate, human-reviewed step outside
this repo). Re-running the same day is idempotent (a post already logged today is skipped).

Each JSONL row:

```json
{
  "logged_at": "2026-09-10T08:00:00.000Z",
  "post_id": "...",
  "url": "...",
  "posted_at": "...",
  "hours_live": 23.4,
  "likes": 812,
  "comments": 44,
  "shares": 12,
  "x_factor": 2.1,
  "performance_bucket": "great",
  "followers_gained_that_day": 340,
  "followers_measurement_status": "measured"
}
```

`performance_bucket` is one of `flop` / `ok` / `good` / `great` / `viral` (likes thresholds:
`<200` / `200-499` / `500-749` / `750-999` / `>=1000`). `followers_gained_that_day` is `null` when the
day is not cleanly attributable to a single post, and `followers_measurement_status`
(`measured` / `stale` / `unavailable`) always says why.

- **Command:** `npm run post-loop:daily`
- **Required log path** (the log must live OUTSIDE this repo, since no private content belongs in it).
  Provide it one of two ways, or the script throws:
  - CLI arg: `npm run post-loop:daily -- /path/to/post-performance.jsonl`
  - env var: `POST_LOOP_LOG_PATH=/path/to/post-performance.jsonl npm run post-loop:daily`

### Optional add-ons: draft matching + audience-fit profile

Two optional steps run for each post already found in the T+20-30h window, after that post's row is
computed but before it is appended to the log. Both are Hermes-side data, so both point at directories
OUTSIDE this repo, and both are non-fatal per post: a failure in either never stops that post's JSONL
row from being logged, and never stops the other posts in the same run. Running the script with neither
env var set behaves exactly as before (same row shape, same output).

Two new **optional** env vars (never defaulted to a path inside this repo):

- `DRAFTS_DIR` — directory of per-day Picard draft files (Part A, draft matching). Unset means skip
  draft matching entirely for the run.
- `AUDIENCE_PROFILE_DIR` — directory holding the living audience-fit profile doc plus its processed-id
  manifest (Part B). Unset means skip the profile step entirely.

**Part A: draft matching.** For each in-window post, the script scans draft files for the posted day
plus the 10 days before it (a post can be drafted one day and posted another), embeds the post's
scraped `content` and each candidate draft via Voyage (`embedTexts`), and takes the highest cosine
similarity. A best score `>= 0.55` is recorded as a match; anything lower is an explicit null (she
self-authored it, or edited so heavily nothing matched). The `0.55` floor is a content-similarity
floor, not a paraphrase floor, since she edits drafts before posting. Draft matching needs a Voyage
key; if the embed call throws (missing key, network error), that post's match is null and the run
continues.

Three new fields on `PostPerformanceRow` (existing fields unchanged):

- `matched_draft_id: string | null`
- `matched_draft_archetype: string | null`
- `draft_match_similarity: number | null`

When `DRAFTS_DIR` is set, all three are present on every row (null when nothing cleared the
threshold). When `DRAFTS_DIR` is unset, the three fields are omitted entirely so the row is
byte-identical to the pre-add-on shape. They are never a fabricated low number.

**Drafts-dir file shape.** One JSON file per date, named `YYYY-MM-DD.json`, written by the Hermes-side
pipeline:

```json
{
  "date": "2026-09-10",
  "drafts": [
    { "id": "d1", "archetype": "tofu-contrarian", "signal_source": "...", "text": "full draft post text..." },
    { "id": "d2", "archetype": "tofu-howto", "signal_source": "...", "text": "..." }
  ]
}
```

Each draft needs `id`, `archetype`, and `text` (strings); `signal_source` is optional and ignored by
the match. A missing file for a date in the window is simply no candidates, not an error. Draft
embeddings are memoized by draft id within a run.

**Part B: audience-fit profile update.** After a post's row is appended, if its `performance_bucket`
is `good` / `great` / `viral` (likes `>= 500`) and its id is not already recorded as processed, the
script folds the post into a living profile doc. It reads `AUDIENCE_PROFILE_DIR/processed-post-ids.json`
(a JSON array of post-id strings, missing file treated as `[]`), skips the post if its id is already
there (this is what makes the step idempotent across re-runs and days), reads the current
`AUDIENCE_PROFILE_DIR/audience-fit-profile.md` (missing file treated as empty, i.e. the first post ever
folded in), and asks Claude for an updated full doc that merges the new post's topic/archetype/take
into existing groupings where it fits (adding a new grouping only when genuinely distinct). If Part A
found a match, the matched archetype and an "edited before posting" note are passed into the rewrite.
The returned text overwrites `audience-fit-profile.md`, and the post id is appended to
`processed-post-ids.json`.

Part B reuses the existing `lib/anthropic.ts` adapter (a narrowly-scoped `completeText` function
alongside `describeImage`); it does not add a new adapter layer. `completeText` shells out to the
local `claude` CLI (print mode, JSON output), using Basia's existing Claude subscription — no API key
needed. Requires the `claude` CLI installed and authenticated (`claude auth status`) on the machine
running the cron. Part B is still gated on an `anthropic_api_key` being present in the `settings`
table; if none is configured, Part B is skipped for the run (a single stderr line, no retry loop).
The whole step is non-fatal: any failure is logged to stderr and the post's already-appended
performance row stands.
