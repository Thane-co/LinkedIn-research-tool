// Layer 2 — scraped LinkedIn profiles store (PRD §6.6, §19). Storage only. A profile is NOT a post:
// it never enters the posts / x-factor / dedup / enrich pipeline. `id` is the clean public identifier
// (slug); a re-scrape upserts (refreshes) the row. Feeds the ProfileScrape panel.

import { getDb } from '@/lib/db/db'
import type { ProfileRow } from '@/lib/types'

const COLUMNS =
  'id, url, name, headline, about, followers, connections, location, avatar_url, experience, education, skills, scraped_at, raw_data'

/** Insert a scraped profile, or refresh it in place when the same id is scraped again. */
export function upsertProfile(p: ProfileRow): void {
  getDb()
    .prepare(
      `INSERT INTO profiles (${COLUMNS})
       VALUES (@id, @url, @name, @headline, @about, @followers, @connections, @location, @avatar_url,
               @experience, @education, @skills, @scraped_at, @raw_data)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url, name = excluded.name, headline = excluded.headline, about = excluded.about,
         followers = excluded.followers, connections = excluded.connections, location = excluded.location,
         avatar_url = excluded.avatar_url, experience = excluded.experience, education = excluded.education,
         skills = excluded.skills, scraped_at = excluded.scraped_at, raw_data = excluded.raw_data`,
    )
    .run(p)
}

/** A single profile by its clean id (slug), or null. */
export function getProfile(id: string): ProfileRow | null {
  return (getDb().prepare(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`).get(id) as ProfileRow | undefined) ?? null
}

/** A single profile by its canonical url, or null. */
export function getProfileByUrl(url: string): ProfileRow | null {
  return (getDb().prepare(`SELECT ${COLUMNS} FROM profiles WHERE url = ?`).get(url) as ProfileRow | undefined) ?? null
}

/** All scraped profiles, newest scrape first. */
export function listProfiles(): ProfileRow[] {
  return getDb().prepare(`SELECT ${COLUMNS} FROM profiles ORDER BY scraped_at DESC`).all() as ProfileRow[]
}
