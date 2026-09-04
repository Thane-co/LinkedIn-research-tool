// Layer 4 — GET /api/v1/creators (PRD §20). The tracked creator list, read-only (the dashboard's
// POST/DELETE live on /api/creators and are deliberately not mirrored here).

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { listCreators } from '@/lib/db/creators.repo'
import { VALID_PLATFORMS } from '@/lib/posts-query'
import type { CreatorTier, Platform } from '@/lib/types'

export const dynamic = 'force-dynamic'

const TIERS: readonly CreatorTier[] = ['core', 'watch']

/** Drop an unrecognized value instead of casting it into the query. Blindly casting `platform` meant
 *  `platform=LinkedIn` returned an empty list here while the same typo on /api/v1/posts returned
 *  everything — the two endpoints disagreeing about the same input. Both now ignore it. */
function oneOf<T extends string>(allowed: readonly T[], raw: string | null): T | undefined {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  const sp = new URL(req.url).searchParams
  const platform = oneOf(VALID_PLATFORMS as readonly Platform[], sp.get('platform')?.toLowerCase() ?? null)
  const tier = oneOf(TIERS, sp.get('tier')?.toLowerCase() ?? null)
  return NextResponse.json(listCreators({ tier, tag: sp.get('tag') ?? undefined, platform }))
}
