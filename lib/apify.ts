// Layer 2 — Apify client + actor input builders (PRD §10.1/§10.2, §12 step 17).
// Hand-rolled fetch client (startActor -> pollRun -> getResults). Reads the token from settings
// (BYO); throws a clear error when it is unset. Never logs the token.

import { fetchWithTimeout } from '@/lib/http'
import { getKey } from '@/lib/settings'
import type {
  ApifyInstagramPost,
  ApifyPost,
  ApifyProfile,
  ApifySubstackPost,
  ApifyTweet,
  Timeframe,
} from '@/lib/types'

/** Optional bounds shared by the Substack builders (§10.2). */
export interface SubstackOpts {
  dateFrom?: string
  dateTo?: string
  minReactions?: number
  // Also scrape the creator's Notes feed (userHandles). Off by default — Notes ~double the work/cost,
  // so a posts-only run is much faster (§17).
  includeNotes?: boolean
}

const BASE = 'https://api.apify.com/v2'
const POLL_INTERVAL_MS = 1500
const MAX_POLLS = 400 // ~10-min whole-run ceiling (MAX_POLLS * POLL_INTERVAL_MS); PRD §10.7
// Per-request timeouts (PRD §10.7) bound single-request latency so a hung connection can't wedge
// the run forever — without them a stuck poll never even reaches MAX_POLLS. The whole-run budget
// stays the poll ceiling above, not these.
const START_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000
const ITEMS_TIMEOUT_MS = 60_000

// Timeframe -> actor-specific bounds (PRD §10.2). harvestapi/linkedin-post-search rejects "past-X"
// strings: Field input.postedLimit must be one of "any"|"1h"|"24h"|"week"|"month"|"3months"|
// "6months"|"year" (confirmed from the actor's live 400 response) — same enum as the profile actor
// below, not the "past-X" values this used to send, which made every LinkedIn keyword scrape
// silently return 0 posts (non-fatal per-run catch masked it as an empty result, not a failure).
const POSTED_LIMIT: Record<Timeframe, string> = {
  all: 'any',
  '24h': '24h',
  '3d': 'week', // no 3-day option on the actor
  week: 'week',
  month: 'month',
  '3months': '3months',
  custom: 'any',
}
const MAX_POSTS_PER_PROFILE: Record<Timeframe, number> = {
  all: 500, // 'all' = full-history backfill; 500 is the Substack actor's ceiling (§17)
  '24h': 10,
  '3d': 20,
  week: 30,
  month: 50,
  '3months': 100,
  custom: 50,
}

// Substack Notes are far more frequent than articles, so they get their own (higher) caps. The
// actor's ceiling for maxNotesPerAuthor is 500 (§17). 'all' = full-history.
const MAX_NOTES_PER_AUTHOR: Record<Timeframe, number> = {
  all: 500,
  '24h': 20,
  '3d': 40,
  week: 60,
  month: 150,
  '3months': 300,
  custom: 100,
}

// harvestapi/linkedin-profile-posts uses a DIFFERENT postedLimit enum than the keyword actor above
// (no 'past-' prefix): any|1h|24h|week|month|3months|6months|year (confirmed from its input schema).
// WITHOUT this, a creator scrape only caps the post COUNT — so "week" pulls 30 posts spanning ~50
// days, re-fetching (and re-paying for) old posts. This bounds the fetch by DATE too (§10.2, §17).
const PROFILE_POSTED_LIMIT: Record<Timeframe, string> = {
  all: 'any',
  '24h': '24h',
  '3d': 'week', // the actor has no 3-day option; the count cap (20) keeps it tight
  week: 'week',
  month: 'month',
  '3months': '3months',
  custom: 'any',
}

// --- input builders (pure; no I/O) ----------------------------------------
export function buildLinkedInKeywordInput(keywords: string[], timeframe: Timeframe): object {
  return {
    searchQueries: keywords,
    sortBy: 'relevance',
    postedLimit: POSTED_LIMIT[timeframe],
    maxPosts: 200,
    scrapeComments: false,
    scrapeReactions: false,
  }
}

export function buildLinkedInCreatorInput(profileUrls: string[], timeframe: Timeframe): object {
  // harvestapi/linkedin-profile-posts input keys are `targetUrls` + `maxPosts` (NOT profileUrls /
  // maxPostsPerProfile). Sending the wrong key names is silently ignored by the actor, which then
  // falls back to its own default (~50 posts) and returns only the most-recent page — so a creator
  // scrape never reached back a year. Names verified against the actor's live input schema.
  return {
    targetUrls: profileUrls,
    maxPosts: MAX_POSTS_PER_PROFILE[timeframe],
    postedLimit: PROFILE_POSTED_LIMIT[timeframe], // bound by DATE, not just count (§10.2)
  }
}

/**
 * §23 comments input for harvestapi/linkedin-post-comments. `maxItems: 0` asks for every comment, and
 * `scrapeReplies` returns replies as separate items so her own answers are captured too. Profile
 * enrichment is left at the actor's default: each comment already carries name, slug and headline.
 */
export function buildLinkedInCommentsInput(postUrls: string[]): object {
  return {
    posts: postUrls,
    maxItems: 0,
    scrapeReplies: true,
  }
}

export function buildTwitterKeywordInput(
  keywords: string[],
  opts?: { minimumFavorites?: number; start?: string; end?: string; tweetLanguage?: string },
): object {
  return {
    searchTerms: keywords,
    maxItems: 200,
    sort: 'Top',
    ...(opts?.minimumFavorites !== undefined && { minimumFavorites: opts.minimumFavorites }),
    ...(opts?.start !== undefined && { start: opts.start }),
    ...(opts?.end !== undefined && { end: opts.end }),
    ...(opts?.tweetLanguage !== undefined && { tweetLanguage: opts.tweetLanguage }),
  }
}

export function buildTwitterCreatorInput(
  handles: string[],
  opts?: { minimumFavorites?: number },
): object {
  return {
    twitterHandles: handles,
    maxItems: 50,
    sort: 'Latest',
    ...(opts?.minimumFavorites !== undefined && { minimumFavorites: opts.minimumFavorites }),
  }
}

/** Spread the optional Substack bounds (§10.2) only when present, so defaults aren't clobbered. */
function substackOpts(opts?: SubstackOpts): object {
  return {
    ...(opts?.dateFrom !== undefined && { dateFrom: opts.dateFrom }),
    ...(opts?.dateTo !== undefined && { dateTo: opts.dateTo }),
    ...(opts?.minReactions !== undefined && { minReactions: opts.minReactions }),
  }
}

// Substack uses ONE actor for both modes (§10.1); only the input shape differs. Keyword search
// discovers publications via searchQueries; creator scrape targets known publication urls.
export function buildSubstackKeywordInput(
  keywords: string[],
  timeframe: Timeframe,
  opts?: SubstackOpts,
): object {
  return {
    searchQueries: keywords,
    maxSearchResults: 25,
    maxPostsPerPublication: MAX_POSTS_PER_PROFILE[timeframe],
    ...substackOpts(opts),
  }
}

// Scrape a creator's full output by handle (§17): `publicationHandles` gets their articles/posts,
// `userHandles` gets their Notes feed (posts and notes are different record types). A
// `substack.com/@handle` user-PROFILE url in `urls` returns nothing, so we target by handle.
export function buildSubstackCreatorInput(
  handles: string[],
  timeframe: Timeframe,
  opts?: SubstackOpts,
): object {
  return {
    publicationHandles: handles, // articles/posts (always)
    // Notes feed is opt-in — it roughly doubles the work, so it's off unless requested. The actor's
    // own `includeNotes` boolean defaults to FALSE, so it MUST be set true (userHandles alone does
    // nothing) or no notes are scraped (§17).
    ...(opts?.includeNotes
      ? { userHandles: handles, includeNotes: true, maxNotesPerAuthor: MAX_NOTES_PER_AUTHOR[timeframe] }
      : {}),
    maxPostsPerPublication: MAX_POSTS_PER_PROFILE[timeframe],
    ...substackOpts(opts),
  }
}

/**
 * Instagram creator input (§18) for apify/instagram-post-scraper. The `username` field accepts bare
 * handles OR full profile urls; `resultsLimit` caps posts per profile. There is NO keyword mode — the
 * post scraper is profile-driven. `onlyPostsNewerThan` (YYYY-MM-DD) bounds by date so a short timeframe
 * doesn't re-pull (and re-pay for) old posts, mirroring the LinkedIn/Substack creator bound.
 */
export function buildInstagramCreatorInput(
  targets: string[],
  timeframe: Timeframe,
  opts?: { onlyNewerThan?: string },
): object {
  return {
    username: targets,
    resultsLimit: MAX_POSTS_PER_PROFILE[timeframe],
    ...(opts?.onlyNewerThan !== undefined && { onlyPostsNewerThan: opts.onlyNewerThan }),
  }
}

/**
 * LinkedIn PROFILE scraper input (§19) for harvestapi/linkedin-profile-scraper. `queries` accepts full
 * profile urls OR bare public identifiers (e.g. 'basiakubicka'). `profileScraperMode` picks the pricing
 * tier — the cheaper details-only tier (no email lookup) is all the research/profile-rewrite use case
 * needs. Value strings verified against the actor's live input schema.
 */
export function buildLinkedInProfileInput(queries: string[]): object {
  return {
    queries,
    profileScraperMode: 'Profile details no email ($4 per 1k)',
  }
}

// --- client (I/O; token from settings) ------------------------------------
function requireToken(): string {
  const token = getKey('apify_api_token')
  if (!token) {
    throw new Error('Apify API token is not set — add it in Settings before scraping.')
  }
  return token
}

/** Actor ids use `~` in place of `/` in Apify REST paths (e.g. harvestapi~linkedin-post-search). */
const actorPath = (actorId: string): string => actorId.replace('/', '~')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TERMINAL_OK = 'SUCCEEDED'
const TERMINAL_BAD = new Set(['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'])
// A long run (e.g. transcription can poll for 20+ min) makes hundreds of poll requests; a single
// transient network blip must NOT abandon — and orphan the billing of — an otherwise-healthy run.
// Tolerate this many CONSECUTIVE poll errors (reset on any success) before giving up.
const MAX_POLL_NET_ERRORS = 6
const ITEMS_FETCH_ATTEMPTS = 3

/** Start an actor run, poll to completion (SUCCEEDED), fetch and return dataset items.
 *  `opts.maxPolls` overrides the default poll ceiling for slow actors (e.g. transcription, which can
 *  legitimately run far longer than a scrape) so we don't abandon — and pay for — an unfinished run. */
export async function runActor(
  actorId: string,
  input: object,
  opts?: { maxPolls?: number },
): Promise<(ApifyPost | ApifyTweet | ApifySubstackPost | ApifyInstagramPost | ApifyProfile)[]> {
  const token = requireToken()
  const maxPolls = opts?.maxPolls ?? MAX_POLLS

  const startRes = await fetchWithTimeout(
    `${BASE}/acts/${actorPath(actorId)}/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    START_TIMEOUT_MS,
  )
  if (!startRes.ok) throw new Error(`Apify: failed to start actor ${actorId} (${startRes.status})`)
  const started = (await startRes.json()) as { data: { id: string; defaultDatasetId: string } }
  const { id: runId, defaultDatasetId } = started.data

  let succeeded = false
  let consecutiveErrors = 0
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    let status: string
    try {
      const statusRes = await fetchWithTimeout(`${BASE}/actor-runs/${runId}?token=${token}`, {}, POLL_TIMEOUT_MS)
      if (!statusRes.ok) throw new Error(`Apify: failed to poll run ${runId} (${statusRes.status})`)
      status = ((await statusRes.json()) as { data: { status: string } }).data.status
      consecutiveErrors = 0
    } catch (err) {
      // Transient network/timeout blip mid-poll — retry a few times before abandoning the run.
      if (++consecutiveErrors > MAX_POLL_NET_ERRORS) throw err
      console.warn(
        `Apify: transient poll error for run ${runId} (${consecutiveErrors}/${MAX_POLL_NET_ERRORS}): ${(err as Error).message}`,
      )
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (status === TERMINAL_OK) {
      succeeded = true
      break
    }
    if (TERMINAL_BAD.has(status)) {
      throw new Error(`Apify: run ${runId} failed with status ${status}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  // Hitting the ceiling without SUCCEEDED must FAIL — never fall through and fetch a partial/empty
  // dataset that would be reported as a silently-wrong success (PRD §10.7).
  if (!succeeded) {
    throw new Error(
      `Apify: run ${runId} did not finish within ~${Math.round((maxPolls * POLL_INTERVAL_MS) / 60000)} min`,
    )
  }

  // Retry the final dataset fetch a few times too — a transient blip here would otherwise discard a
  // fully-completed (and already-billed) run.
  let lastErr: unknown
  for (let attempt = 1; attempt <= ITEMS_FETCH_ATTEMPTS; attempt++) {
    try {
      const itemsRes = await fetchWithTimeout(
        `${BASE}/datasets/${defaultDatasetId}/items?token=${token}`,
        {},
        ITEMS_TIMEOUT_MS,
      )
      if (!itemsRes.ok) throw new Error(`Apify: failed to fetch dataset ${defaultDatasetId} (${itemsRes.status})`)
      return (await itemsRes.json()) as (ApifyPost | ApifyTweet | ApifySubstackPost | ApifyInstagramPost | ApifyProfile)[]
    } catch (err) {
      lastErr = err
      if (attempt < ITEMS_FETCH_ATTEMPTS) await sleep(POLL_INTERVAL_MS)
    }
  }
  throw lastErr
}
