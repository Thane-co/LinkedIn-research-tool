// Daily post-performance + follower-attribution loop for Basia's OWN posts (spec: content loop, Part 4).
//
// Once a day (an 8am cron) this captures how each of her posts did ~23h after going live and logs one
// structured JSON line per post for a later, separate, human-reviewed pattern-mining pass. It captures
// raw facts ONLY — it does not read or write draft text, edits, or skill names, and it computes no
// lessons. That downstream step lives outside this repo (Hermes), per this repo's scope guard.
//
// The log file must NOT live inside this repo (no private content in a public repo): pass the output
// path as the first CLI arg or set POST_LOOP_LOG_PATH. With neither, this throws rather than defaulting
// to a path inside the repo.
//
//   POST_LOOP_LOG_PATH=/path/to/post-performance.jsonl npm run post-loop:daily
//   npm run post-loop:daily -- /path/to/post-performance.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runScrape } from '@/jobs/scrape'
import { snapshotFollowers } from '@/jobs/snapshot-followers'
import { completeText } from '@/lib/anthropic'
import { listCreators } from '@/lib/db/creators.repo'
import { getAuthorHistory } from '@/lib/db/posts.repo'
import { creatorGrowthDetail } from '@/lib/followers-query'
import { performanceBucket } from '@/lib/pure/performance-bucket'
import { cosine } from '@/lib/pure/similarity'
import { windowGrowth } from '@/lib/pure/follower-growth'
import { getKey, getSettings } from '@/lib/settings'
import { embedTexts } from '@/lib/voyage'
import type { PostRow } from '@/lib/types'

const OWN_AUTHOR_ID = 'basiakubicka'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// A loose window around the T+23h target so the 8am cron catches a post made anytime around her usual
// ~9am slot the day before, whether it's exactly 23h old yet or not.
const MIN_HOURS = 20
const MAX_HOURS = 30
const ATTRIBUTION_WINDOW_DAYS = 2

// Part A — how far back to look for the draft that seeded a post. A post can be drafted one day and
// posted a different day, so we scan the posted day plus the 10 days before it.
const DRAFT_WINDOW_DAYS = 10
// A content-similarity floor, not a strict paraphrase floor: she edits drafts before posting, so an
// exact match is rare — 0.55 catches "this post grew out of that draft" without false-matching on
// generic topic overlap.
const DRAFT_MATCH_THRESHOLD = 0.55

export type MeasurementStatus = 'measured' | 'stale' | 'unavailable'

export interface PostPerformanceRow {
  logged_at: string
  post_id: string
  url: string | null
  posted_at: string
  hours_live: number
  likes: number
  comments: number
  shares: number
  x_factor: number | null
  performance_bucket: ReturnType<typeof performanceBucket>
  followers_gained_that_day: number | null
  followers_measurement_status: MeasurementStatus
  // Part A (draft matching) — present only when DRAFTS_DIR is configured; null when no draft cleared
  // the similarity threshold. Absent (not null) when draft matching didn't run at all.
  matched_draft_id?: string | null
  matched_draft_archetype?: string | null
  draft_match_similarity?: number | null
}

interface Draft {
  id: string
  archetype: string
  signal_source?: string
  text: string
}

interface DraftMatch {
  draft_id: string
  archetype: string
  similarity: number
}

/** The output path from an explicit arg, else POST_LOOP_LOG_PATH. Never defaults into this repo. */
export function resolveLogPath(cliPath?: string): string {
  const path = cliPath ?? process.env.POST_LOOP_LOG_PATH
  if (!path) {
    throw new Error(
      'daily-post-performance: no log path — pass one as the first CLI argument or set POST_LOOP_LOG_PATH ' +
        '(the log must live OUTSIDE this repo; no private content belongs in it)',
    )
  }
  return path
}

/** Optional Hermes-side dir from an explicit opt else its env var. Undefined = the step is skipped.
 *  Never defaults into this repo (no private content belongs here — same rule as the log path). */
function resolveOptionalDir(explicit: string | undefined, envVar: string): string | undefined {
  return explicit ?? process.env[envVar] ?? undefined
}

/** The `YYYY-MM-DD` strings for the posted day plus the `DRAFT_WINDOW_DAYS` days before it. */
function draftWindowDates(postedAt: string): string[] {
  const base = Date.parse(`${postedAt.slice(0, 10)}T00:00:00.000Z`)
  const dates: string[] = []
  for (let d = 0; d <= DRAFT_WINDOW_DAYS; d++) {
    dates.push(new Date(base - d * DAY_MS).toISOString().slice(0, 10))
  }
  return dates
}

/** Drafts saved for one date (cached per run). A missing file is simply no drafts, never an error. */
function loadDraftsForDate(draftsDir: string, date: string, fileCache: Map<string, Draft[]>): Draft[] {
  const cached = fileCache.get(date)
  if (cached) return cached
  const path = join(draftsDir, `${date}.json`)
  let drafts: Draft[] = []
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { drafts?: Draft[] }
    drafts = Array.isArray(parsed.drafts)
      ? parsed.drafts.filter((d) => typeof d?.id === 'string' && typeof d?.archetype === 'string' && typeof d?.text === 'string')
      : []
  }
  fileCache.set(date, drafts)
  return drafts
}

/**
 * Best-matching Picard draft for a post, or null when none clears DRAFT_MATCH_THRESHOLD. Embeds the
 * post's actual scraped content once and each candidate draft once (memoized by draft id across posts
 * in the run), then takes the highest cosine. Throws only if the embed call itself fails — the caller
 * turns that into a null match so one bad post never sinks the run.
 */
async function matchPostToDraft(
  post: PostRow,
  draftsDir: string,
  draftEmbCache: Map<string, number[]>,
  fileCache: Map<string, Draft[]>,
): Promise<DraftMatch | null> {
  // Candidate drafts from the posted day plus the 10 days before, de-duped by id.
  const byId = new Map<string, Draft>()
  for (const date of draftWindowDates(post.posted_at ?? '')) {
    for (const draft of loadDraftsForDate(draftsDir, date, fileCache)) byId.set(draft.id, draft)
  }
  const candidates = [...byId.values()]
  if (candidates.length === 0) return null // no draft that week — a null match, no embed call needed

  const [postEmbedding] = await embedTexts([post.content ?? ''])
  const uncached = candidates.filter((d) => !draftEmbCache.has(d.id))
  if (uncached.length > 0) {
    const embeddings = await embedTexts(uncached.map((d) => d.text))
    uncached.forEach((d, i) => draftEmbCache.set(d.id, embeddings[i]!))
  }

  let best: DraftMatch | null = null
  for (const draft of candidates) {
    const similarity = cosine(postEmbedding!, draftEmbCache.get(draft.id)!)
    if (!best || similarity > best.similarity) {
      best = { draft_id: draft.id, archetype: draft.archetype, similarity }
    }
  }
  return best && best.similarity >= DRAFT_MATCH_THRESHOLD ? best : null
}

/** Post ids already folded into the profile (missing manifest = none). */
function readProcessedIds(profileDir: string): string[] {
  const path = join(profileDir, 'processed-post-ids.json')
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
}

/** The rewrite prompt: fold this post into the existing profile doc, merging rather than duplicating. */
function buildProfilePrompt(currentProfile: string, post: PostRow, match: DraftMatch | null): string {
  const draftNote = match
    ? `This post grew out of a "${match.archetype}" draft she wrote, then edited before posting ` +
      `(content similarity ${match.similarity.toFixed(2)}), so weight the archetype but trust the posted text over the draft.`
    : 'This post was self-authored (no matching draft), so it reflects her own instinct for what resonates.'

  return [
    'You maintain an "audience-fit profile" — a living doc describing what topics, angles, and post ',
    'archetypes land with Basia\'s LinkedIn audience, grouped by theme.',
    '',
    'Here is the current profile doc (may be empty if this is the first post ever folded in):',
    '"""',
    currentProfile,
    '"""',
    '',
    'A new post of hers just crossed 500 likes. Fold it into the profile: merge it into an existing ',
    'grouping where it fits, add a new grouping only if it is genuinely distinct, and keep the doc\'s ',
    'existing structure and style intact. Do not duplicate a point that is already there.',
    '',
    `Post content:\n"""\n${post.content ?? ''}\n"""`,
    `Engagement: ${post.likes} likes, ${post.comments} comments, ${post.shares} shares` +
      `${post.x_factor !== null ? `, x-factor ${post.x_factor}` : ''} (bucket: ${performanceBucket(post.likes)}).`,
    draftNote,
    '',
    'Return the FULL updated profile doc and nothing else.',
  ].join('\n')
}

/**
 * Fold a 500+ like post into the audience-fit profile doc. Idempotent via the processed-ids manifest,
 * so re-runs and later days never double-count. Non-fatal by contract: the caller wraps this so any
 * failure (missing key, file error) is logged and the post's already-appended perf row stands.
 */
async function updateAudienceProfile(profileDir: string, post: PostRow, match: DraftMatch | null): Promise<'updated' | 'already-processed'> {
  const processed = readProcessedIds(profileDir)
  if (processed.includes(post.id)) return 'already-processed' // already folded in — keeps it idempotent

  const profilePath = join(profileDir, 'audience-fit-profile.md')
  const current = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : ''

  const updated = await completeText({ prompt: buildProfilePrompt(current, post, match) })
  if (updated === null) {
    // Key vanished between the pre-check and here — treat as a no-op rather than writing an empty doc.
    throw new Error('Anthropic returned no text (missing key or empty completion)')
  }

  mkdirSync(profileDir, { recursive: true })
  writeFileSync(profilePath, updated)
  writeFileSync(join(profileDir, 'processed-post-ids.json'), `${JSON.stringify([...processed, post.id], null, 2)}\n`)
  return 'updated'
}

/** Post ids already logged on `day` (YYYY-MM-DD), so a re-run the same day never double-logs. */
function alreadyLoggedOn(logPath: string, day: string): Set<string> {
  const seen = new Set<string>()
  if (!existsSync(logPath)) return seen
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Partial<PostPerformanceRow>
      if (typeof row.post_id === 'string' && typeof row.logged_at === 'string' && row.logged_at.slice(0, 10) === day) {
        seen.add(row.post_id)
      }
    } catch {
      // A corrupt line never blocks today's run — skip it, don't throw.
      console.error('daily-post-performance: skipping unparseable log line')
    }
  }
  return seen
}

export async function run(
  opts: { logPath?: string; now?: Date; draftsDir?: string; audienceProfileDir?: string } = {},
): Promise<PostPerformanceRow[]> {
  // Resolve the log path FIRST, before any scrape, so a misconfigured cron fails fast and cheap.
  const logPath = resolveLogPath(opts.logPath)
  // Both new steps are optional Hermes-side enhancements; unset = skip that step entirely.
  const draftsDir = resolveOptionalDir(opts.draftsDir, 'DRAFTS_DIR')
  const audienceProfileDir = resolveOptionalDir(opts.audienceProfileDir, 'AUDIENCE_PROFILE_DIR')
  const now = opts.now ?? new Date()
  const loggedAt = now.toISOString()
  const today = loggedAt.slice(0, 10)

  // 1. Re-scrape her recent posts (creator mode, just her row) so likes/x_factor are fresh.
  const her = listCreators({ platform: 'linkedin' }).creators.find((c) => c.author_id === OWN_AUTHOR_ID)
  if (her) {
    await runScrape({
      mode: 'creator',
      platforms: ['linkedin'],
      timeframe: '3d',
      creatorIds: [her.id],
      market: getSettings().default_market ?? 'ai',
    })
  } else {
    console.error(`daily-post-performance: no creator row for ${OWN_AUTHOR_ID} — skipping her re-scrape`)
  }

  // 2. Capture today's follower count for ALL core creators (the function batches everyone).
  await snapshotFollowers()

  // 3. Her posts in the loose T+23h window, not already logged today.
  const seen = alreadyLoggedOn(logPath, today)
  const inWindow = getAuthorHistory(OWN_AUTHOR_ID).filter((p) => {
    if (!p.posted_at) return false
    const hours = (now.getTime() - Date.parse(p.posted_at)) / HOUR_MS
    return hours >= MIN_HOURS && hours <= MAX_HOURS && !seen.has(p.id)
  })

  // Attribution + staleness read once from her recent series (per-post lookups are cheap slices of it).
  const detail = creatorGrowthDetail(OWN_AUTHOR_ID, { days: ATTRIBUTION_WINDOW_DAYS })
  const stale = windowGrowth(detail.series, { windowDays: ATTRIBUTION_WINDOW_DAYS, asOf: today })?.stale ?? false

  // Part A/B are optional add-ons. These caches live across the whole run so drafts embedded for one
  // post are reused for the next; the "no key" warning fires at most once per run.
  const draftEmbCache = new Map<string, number[]>()
  const draftFileCache = new Map<string, Draft[]>()
  const anthropicKeyPresent = Boolean(getKey('anthropic_api_key'))
  let warnedNoAnthropicKey = false

  const logged: PostPerformanceRow[] = []
  for (const post of inWindow) {
    try {
      const postDay = post.posted_at!.slice(0, 10)
      const day = detail.days.find((d) => d.captured_on === postDay) ?? null
      // A day's gain belongs to a post only when that post alone owns the day (attributeDay refuses to
      // split a multi-post day). Otherwise the number is null — and the status says why.
      const gained = day && day.attributable_post_id === post.id ? day.gained : null
      const status: MeasurementStatus = gained !== null ? 'measured' : stale ? 'stale' : 'unavailable'

      // Part A — match against stored Picard drafts (non-fatal: an embed failure is a null match).
      let draftMatch: DraftMatch | null = null
      if (draftsDir) {
        try {
          draftMatch = await matchPostToDraft(post, draftsDir, draftEmbCache, draftFileCache)
        } catch (err) {
          console.error(`post-loop: draft-match failed for ${post.id} — ${err instanceof Error ? err.message : err}`)
        }
      }

      const row: PostPerformanceRow = {
        logged_at: loggedAt,
        post_id: post.id,
        url: post.url,
        posted_at: post.posted_at!,
        hours_live: Math.round(((now.getTime() - Date.parse(post.posted_at!)) / HOUR_MS) * 10) / 10,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
        x_factor: post.x_factor,
        performance_bucket: performanceBucket(post.likes),
        followers_gained_that_day: gained,
        followers_measurement_status: status,
      }
      // Only stamp the draft fields when matching actually ran, so a run with no DRAFTS_DIR logs the
      // exact same row shape as before. When it ran, an unmatched post is an EXPLICIT null.
      if (draftsDir) {
        row.matched_draft_id = draftMatch?.draft_id ?? null
        row.matched_draft_archetype = draftMatch?.archetype ?? null
        row.draft_match_similarity = draftMatch?.similarity ?? null
      }

      appendFileSync(logPath, `${JSON.stringify(row)}\n`)
      logged.push(row)
      console.log(
        `post-loop: ${row.post_id} · ${row.performance_bucket} · ${row.likes} likes · ` +
          `${gained === null ? `no attributable gain (${status})` : `+${gained} followers`}` +
          `${draftsDir ? ` · draft ${draftMatch ? `${draftMatch.draft_id} (${draftMatch.similarity.toFixed(2)})` : 'none'}` : ''}`,
      )

      // Part B — fold a 500+ like post into the audience-fit profile. Fully independent of the log row
      // above (already appended), and non-fatal: any failure here is logged and the row still stands.
      const qualifies = row.performance_bucket === 'good' || row.performance_bucket === 'great' || row.performance_bucket === 'viral'
      if (audienceProfileDir && qualifies) {
        if (!anthropicKeyPresent) {
          if (!warnedNoAnthropicKey) {
            console.error('post-loop: AUDIENCE_PROFILE_DIR set but no Anthropic key — skipping profile updates this run')
            warnedNoAnthropicKey = true
          }
        } else {
          try {
            const outcome = await updateAudienceProfile(audienceProfileDir, post, draftMatch)
            console.log(`post-loop: audience-fit profile ${outcome === 'updated' ? 'updated with' : 'already had'} ${post.id}`)
          } catch (err) {
            console.error(`post-loop: audience-fit profile update failed for ${post.id} — ${err instanceof Error ? err.message : err}`)
          }
        }
      }
    } catch (err) {
      // Non-fatal per post: skip this one's line, keep going for the rest.
      console.error(`post-loop: skipping ${post.id} — ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`post-loop: ${today} — logged ${logged.length} post(s) to ${logPath}`)
  return logged
}

// Thin bottom-of-file invocation so the file is unit-testable yet runnable directly.
// Guarded with typeof so importing the module under a test runner never triggers it.
if (typeof require !== 'undefined' && require.main === module) {
  run({ logPath: process.argv[2] }).catch((err) => {
    console.error('daily-post-performance: fatal —', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
