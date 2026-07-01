// Layer 2 — Apify client + actor input builders (PRD §10.1/§10.2, §12 step 17).
// Hand-rolled fetch client (startActor -> pollRun -> getResults). Reads the token from settings
// (BYO); throws a clear error when it is unset. Never logs the token.

import { getKey } from '@/lib/settings'
import type { ApifyPost, ApifyTweet, Timeframe } from '@/lib/types'

const BASE = 'https://api.apify.com/v2'
const POLL_INTERVAL_MS = 1500
const MAX_POLLS = 400

// Timeframe -> actor-specific bounds (PRD §10.2). Values chosen to bound each scrape sensibly.
const POSTED_LIMIT: Record<Timeframe, string> = {
  '24h': 'past-24h',
  '3d': 'past-week',
  week: 'past-week',
  month: 'past-month',
  '3months': 'past-month',
  custom: 'any',
}
const MAX_POSTS_PER_PROFILE: Record<Timeframe, number> = {
  '24h': 10,
  '3d': 20,
  week: 30,
  month: 50,
  '3months': 100,
  custom: 50,
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
): Promise<(ApifyPost | ApifyTweet)[]> {
  const token = requireToken()

  const startRes = await fetch(`${BASE}/acts/${actorPath(actorId)}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!startRes.ok) throw new Error(`Apify: failed to start actor ${actorId} (${startRes.status})`)
  const started = (await startRes.json()) as { data: { id: string; defaultDatasetId: string } }
  const { id: runId, defaultDatasetId } = started.data

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const statusRes = await fetch(`${BASE}/actor-runs/${runId}?token=${token}`)
    if (!statusRes.ok) throw new Error(`Apify: failed to poll run ${runId} (${statusRes.status})`)
    const { data } = (await statusRes.json()) as { data: { status: string } }
    if (data.status === TERMINAL_OK) break
    if (TERMINAL_BAD.has(data.status)) {
      throw new Error(`Apify: run ${runId} failed with status ${data.status}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  const itemsRes = await fetch(`${BASE}/datasets/${defaultDatasetId}/items?token=${token}`)
  if (!itemsRes.ok) throw new Error(`Apify: failed to fetch dataset ${defaultDatasetId}`)
  return (await itemsRes.json()) as (ApifyPost | ApifyTweet)[]
}
