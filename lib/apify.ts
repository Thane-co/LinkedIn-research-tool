// Layer 2 — Apify client + actor input builders (PRD §10.1/§10.2, §12 step 17).
// Reads token + actor ids from settings (BYO); throws a clear error when the token is unset.
// TDD: msw-mock Apify HTTP; input builders are pure (assert shapes); poll loop resolves on
// SUCCEEDED, throws on FAILED; throws clearly when token unset.

import type { ApifyPost, ApifyTweet, Timeframe } from '@/lib/types'

// --- input builders (pure; no I/O) ----------------------------------------
export function buildLinkedInKeywordInput(_keywords: string[], _timeframe: Timeframe): object {
  throw new Error('Not implemented — see PRD §10.2')
}
export function buildLinkedInCreatorInput(_profileUrls: string[], _timeframe: Timeframe): object {
  throw new Error('Not implemented — see PRD §10.2')
}
export function buildTwitterKeywordInput(_keywords: string[], _opts?: {
  minimumFavorites?: number
  start?: string
  end?: string
  tweetLanguage?: string
}): object {
  throw new Error('Not implemented — see PRD §10.2')
}
export function buildTwitterCreatorInput(_handles: string[], _opts?: {
  minimumFavorites?: number
}): object {
  throw new Error('Not implemented — see PRD §10.2')
}

// --- client (I/O; token from settings) ------------------------------------
/** Start an actor run, poll to completion (SUCCEEDED), fetch and return dataset items. */
export function runActor(_actorId: string, _input: object): Promise<(ApifyPost | ApifyTweet)[]> {
  throw new Error('Not implemented — see PRD §10.1')
}
