// Layer 0 — creator pivot (PRD §11.8). Zero I/O.
//
// The creator list is stored one row per ACCOUNT, but it is read one row per PERSON: a table whose
// columns are the platforms, so "how many of these people do we follow on X?" is answerable at a
// glance and a missing cell is an obvious gap to fill.
//
// Accounts group by `persona` (§17.2) when set, else by the name key derived from display_name.
// An account with neither stays on its own row — guessing would silently merge two different people.

import { derivePersonaKey } from '@/lib/pure/persona'
import type { CreatorRow, Platform } from '@/lib/types'

export const TABLE_PLATFORMS: readonly Platform[] = ['linkedin', 'twitter', 'substack', 'instagram'] as const

export interface PersonRow {
  /** Grouping key: persona, else derived name key, else `id:<row id>` for an unlinkable account. */
  key: string
  /** Human label for the row — the first usable display_name, handle, or url. */
  label: string
  /** Every account this person has, per platform. A platform with none holds an empty array. */
  accounts: Record<Platform, CreatorRow[]>
  /** Platforms this person HAS at least one account on. */
  platformCount: number
  /** Platforms this person has no account on — the "+ add" cells. */
  missing: Platform[]
}

const emptyAccounts = (): Record<Platform, CreatorRow[]> => ({
  linkedin: [],
  twitter: [],
  substack: [],
  instagram: [],
})

export function countByPlatform(creators: CreatorRow[]): Record<Platform, number> {
  const counts: Record<Platform, number> = { linkedin: 0, twitter: 0, substack: 0, instagram: 0 }
  for (const c of creators) counts[c.platform] += 1
  return counts
}

/** persona wins; then the normalized display name; then a per-row key so it never merges blindly. */
function groupKey(c: CreatorRow): string {
  const persona = c.persona?.trim()
  if (persona) return persona
  return derivePersonaKey(c.display_name) ?? `id:${c.id}`
}

/**
 * A person's label is the first REAL display name among their accounts, whichever platform it came
 * from; a handle or url is only a fallback when no account has a name at all. Computed once from the
 * finished group — deciding it account-by-account as they arrive got the precedence wrong.
 */
function labelFor(accounts: Record<Platform, CreatorRow[]>): string {
  const all = TABLE_PLATFORMS.flatMap((p) => accounts[p])
  const named = all.find((c) => c.display_name)
  return named?.display_name ?? all[0]?.author_id ?? all[0]?.profile_url ?? '(unnamed)'
}

export function groupCreatorsByPerson(creators: CreatorRow[]): PersonRow[] {
  const byKey = new Map<string, PersonRow>()

  for (const c of creators) {
    const key = groupKey(c)
    let row = byKey.get(key)
    if (!row) {
      row = { key, label: '', accounts: emptyAccounts(), platformCount: 0, missing: [] }
      byKey.set(key, row)
    }
    row.accounts[c.platform].push(c)
  }

  const rows = [...byKey.values()]
  for (const row of rows) {
    row.label = labelFor(row.accounts)
    row.platformCount = TABLE_PLATFORMS.filter((p) => row.accounts[p].length > 0).length
    row.missing = TABLE_PLATFORMS.filter((p) => row.accounts[p].length === 0)
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

/**
 * The short label for one account inside a table cell: the handle when we have one, else the last
 * path segment of the profile url (percent-decoded). Full urls are 60+ chars and blow the column
 * widths apart, and every one of them ends in the identifier anyway.
 */
export function shortAccountLabel(c: CreatorRow): string {
  if (c.author_id) return c.author_id
  try {
    const url = new URL(c.profile_url)
    const segment = url.pathname.split('/').filter(Boolean).pop()
    return segment ? decodeURIComponent(segment) : url.hostname
  } catch {
    return c.profile_url // not a parseable url — show it as stored rather than inventing something
  }
}
