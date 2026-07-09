// Layer 2 — Apify client + actor input builders (PRD §10.1/§10.2, §12 step 17).
// Hand-rolled fetch client (startActor -> pollRun -> getResults). Reads the token from settings
// (BYO); throws a clear error when it is unset. Never logs the token.

import { fetchWithTimeout } from '@/lib/http'
import { getKey } from '@/lib/settings'
import type { ApifyPost, ApifySubstackPost, ApifyTweet, Timeframe } from '@/lib/types'

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

// Timeframe -> actor-specific bounds (PRD §10.2). Values chosen to bound each scrape sensibly.
const POSTED_LIMIT: Record<Timeframe, string> = {
  all: 'any',
  '24h': 'past-24h',
  '3d': 'past-week',
  week: 'past-week',
  month: 'past-month',
  '3months': 'past-month',
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
  return {
    profileUrls,
    maxPostsPerProfile: MAX_POSTS_PER_PROFILE[timeframe],
    postedLimit: PROFILE_POSTED_LIMIT[timeframe], // bound by DATE, not just count (§10.2)
    sortBy: 'date',
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

/** Start an actor run, poll to completion (SUCCEEDED), fetch and return dataset items. */
export async function runActor(
  actorId: string,
  input: object,
): Promise<(ApifyPost | ApifyTweet | ApifySubstackPost)[]> {
  const token = requireToken()

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
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const statusRes = await fetchWithTimeout(`${BASE}/actor-runs/${runId}?token=${token}`, {}, POLL_TIMEOUT_MS)
    if (!statusRes.ok) throw new Error(`Apify: failed to poll run ${runId} (${statusRes.status})`)
    const { data } = (await statusRes.json()) as { data: { status: string } }
    if (data.status === TERMINAL_OK) {
      succeeded = true
      break
    }
    if (TERMINAL_BAD.has(data.status)) {
      throw new Error(`Apify: run ${runId} failed with status ${data.status}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  // Hitting the ceiling without SUCCEEDED must FAIL — never fall through and fetch a partial/empty
  // dataset that would be reported as a silently-wrong success (PRD §10.7).
  if (!succeeded) {
    throw new Error(
      `Apify: run ${runId} did not finish within ~${Math.round((MAX_POLLS * POLL_INTERVAL_MS) / 60000)} min`,
    )
  }

  const itemsRes = await fetchWithTimeout(
    `${BASE}/datasets/${defaultDatasetId}/items?token=${token}`,
    {},
    ITEMS_TIMEOUT_MS,
  )
  if (!itemsRes.ok) throw new Error(`Apify: failed to fetch dataset ${defaultDatasetId}`)
  return (await itemsRes.json()) as (ApifyPost | ApifyTweet | ApifySubstackPost)[]
}
