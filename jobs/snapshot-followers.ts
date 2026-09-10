// Layer 3 — snapshotFollowers: capture today's follower count for every core LinkedIn creator (§21).
//
// Reuses the §19 profile-detail actor, but where scrapeProfile fetches ONE profile on demand, this
// fetches the whole roster on a schedule and appends to the follower_snapshots time series.
//
// Two things make it cheap and safe to run daily:
//   - The actor's `queries` field takes an ARRAY, so the roster goes out in a handful of batched runs
//     rather than one run per creator (67 creators = 2 runs at the default batch size, ~$0.27).
//   - The (author_id, platform, captured_on) primary key means a re-run refreshes the day instead of
//     appending a duplicate, so a retry after a partial failure is always safe.
//
// A chunk that fails is logged and skipped, never fatal: losing 50 creators' numbers for a day is a
// gap in the series, but aborting would lose all 67 and leave the day half-written.

import { buildLinkedInProfileInput, runActor } from '@/lib/apify'
import { listCreators } from '@/lib/db/creators.repo'
import { recordSnapshots, type NewSnapshot } from '@/lib/db/followers.repo'
import { upsertProfile } from '@/lib/db/profiles.repo'
import { mapApifyProfileToRow } from '@/lib/pure/mappers'
import { getSettings } from '@/lib/settings'
import type { ApifyProfile } from '@/lib/types'

/** Apify runs one actor per call; 50 profiles per run keeps a single failure's blast radius small. */
const DEFAULT_BATCH_SIZE = 50

export interface SnapshotResult {
  captured_on: string
  requested: number
  captured: number
  skipped: string[] // returned by the actor but with no usable follower count
  missing: string[] // asked for, never came back
  errors: string[]
}

/** The clean slug for a creator: the stored author_id, else parsed out of the profile url. */
function slugOf(profileUrl: string, authorId: string | null): string | null {
  if (authorId) return authorId
  const m = /\/in\/([^/?#]+)/.exec(profileUrl)
  if (!m?.[1]) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Capture the follower count of every core LinkedIn creator as of `asOf` (an ISO instant, defaulting
 * to now). Returns a per-run report; never throws for a partial failure, only when there is no actor
 * configured at all.
 */
export async function snapshotFollowers(
  opts: { asOf?: string; batchSize?: number } = {},
): Promise<SnapshotResult> {
  const capturedAt = opts.asOf ?? new Date().toISOString()
  const capturedOn = capturedAt.slice(0, 10)
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE

  const actorId = getSettings().apify_profile_detail_actor_id
  if (!actorId) {
    throw new Error(
      'snapshotFollowers: no profile-detail actor configured — set apify_profile_detail_actor_id in Settings',
    )
  }

  // §21.8 — the TRACKED subset, not the whole scrape roster. Two lists: everyone in `creators` is
  // scraped for content research, only the opted-in subset costs a daily profile call.
  const roster = listCreators({ platform: 'linkedin', tracked: true })
    .creators.map((c) => ({ ...c, slug: slugOf(c.profile_url, c.author_id) }))
    .filter((c): c is typeof c & { slug: string } => c.slug !== null)
    // Sorted so chunk boundaries (and therefore what a failed chunk costs) are stable run to run.
    .sort((a, b) => a.slug.localeCompare(b.slug))

  const result: SnapshotResult = {
    captured_on: capturedOn,
    requested: roster.length,
    captured: 0,
    skipped: [],
    missing: [],
    errors: [],
  }
  if (roster.length === 0) return result

  const seen = new Set<string>()

  for (const batch of chunk(roster, batchSize)) {
    let items: ApifyProfile[]
    try {
      items = (await runActor(actorId, buildLinkedInProfileInput(batch.map((c) => c.profile_url)))) as ApifyProfile[]
    } catch (err) {
      // Non-fatal by design: log it, record it in the report, keep going with the next batch.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`snapshotFollowers: batch of ${batch.length} failed — ${message}`)
      result.errors.push(`batch of ${batch.length}: ${message}`)
      continue
    }

    const rows: NewSnapshot[] = []
    for (const item of items) {
      let profile
      try {
        profile = mapApifyProfileToRow(item)
      } catch (err) {
        console.error(`snapshotFollowers: unmappable profile item — ${err instanceof Error ? err.message : err}`)
        continue
      }
      seen.add(profile.id)
      // Keep the §19 profiles table fresh: the actor already paid for the full detail.
      upsertProfile({ ...profile, scraped_at: capturedAt })

      // A 0 is a scrape that came back empty, not an account with no followers. Storing it would
      // invent a crash today and a matching spike tomorrow.
      if (profile.followers > 0) {
        rows.push({
          author_id: profile.id,
          platform: 'linkedin',
          captured_on: capturedOn,
          captured_at: capturedAt,
          followers: profile.followers,
          connections: profile.connections,
          source: 'profile-actor',
        })
      } else {
        result.skipped.push(profile.id)
      }
    }
    result.captured += recordSnapshots(rows)
  }

  result.missing = roster.filter((c) => !seen.has(c.slug)).map((c) => c.slug)
  if (result.missing.length > 0) {
    console.error(`snapshotFollowers: ${result.missing.length} creator(s) returned nothing: ${result.missing.join(', ')}`)
  }
  console.log(
    `snapshotFollowers: ${capturedOn} — ${result.captured}/${result.requested} captured, ` +
      `${result.skipped.length} skipped, ${result.missing.length} missing, ${result.errors.length} batch error(s)`,
  )
  return result
}
