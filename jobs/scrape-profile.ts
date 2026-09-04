// Layer 3 — scrapeProfile: fetch ONE LinkedIn profile's full details + follower count (PRD §19).
// Unlike runScrape (multi-actor, async, produces PostRows), this is a single fast actor run for one
// profile — so it runs synchronously (no scrape_jobs row, no poll loop): the route awaits it directly.
// A profile is NOT a post; it never touches the posts / dedup / x-factor / enrich pipeline.

import { buildLinkedInProfileInput, runActor } from '@/lib/apify'
import { upsertProfile } from '@/lib/db/profiles.repo'
import { mapApifyProfileToRow } from '@/lib/pure/mappers'
import { getSettings } from '@/lib/settings'
import type { ApifyProfile, ProfileRow } from '@/lib/types'

/**
 * Scrape one LinkedIn profile by url OR bare public identifier, persist it (upsert), and return the row.
 * Throws when no profile-detail actor is configured or the actor returns no profile.
 */
export async function scrapeProfile(query: string): Promise<ProfileRow> {
  const actorId = getSettings().apify_profile_detail_actor_id
  if (!actorId) {
    throw new Error('scrapeProfile: no profile-detail actor configured — set apify_profile_detail_actor_id in Settings')
  }
  const items = (await runActor(actorId, buildLinkedInProfileInput([query]))) as ApifyProfile[]
  const first = items[0]
  if (!first) {
    throw new Error(`scrapeProfile: actor returned no profile for "${query}"`)
  }
  const row = mapApifyProfileToRow(first)
  upsertProfile(row)
  return row
}
