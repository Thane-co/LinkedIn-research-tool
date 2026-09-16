// Layer 4 — POST /api/creators/backfill-personas (PRD §11.8, §17.2). Thin.
// One-shot: derive `persona` from display_name for every creator that has none, so the creator table
// can group a person's accounts across platforms. Never overwrites a persona already set.

import { NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { backfillPersonas, listCreators } from '@/lib/db/creators.repo'

// Writes the live DB — never statically prerender/cache (PRD §11/§14).
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  const { updated } = backfillPersonas()
  console.log(`backfill-personas: linked ${updated} creator account(s) to a person key`)
  return NextResponse.json({ updated, ...listCreators() })
}
