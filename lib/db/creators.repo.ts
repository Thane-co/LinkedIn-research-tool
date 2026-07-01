// Layer 2 — creator CRUD + promote logic (PRD §11.2, §12 step 14).
// TDD: insert, unique url, promote watch->core, delete, tag extraction.

import type { CreatorRow, CreatorTier, Platform } from '@/lib/types'

export interface NewCreator {
  platform: Platform
  profile_url: string
  author_id?: string | null
  display_name?: string | null
  avatar_url?: string | null
  tier?: CreatorTier
  tags?: string[]
  market?: string
  notes?: string | null
}

export function listCreators(_filter?: {
  tier?: CreatorTier
  tag?: string
  platform?: Platform
}): { creators: CreatorRow[]; tags: string[] } {
  throw new Error('Not implemented — see PRD §11.2')
}

/** Insert (or promote watch->core if profile_url already exists). */
export function upsertCreator(_creator: NewCreator): CreatorRow {
  throw new Error('Not implemented — see PRD §11.2')
}

export function deleteCreator(_id: string): void {
  throw new Error('Not implemented — see PRD §11.2')
}
