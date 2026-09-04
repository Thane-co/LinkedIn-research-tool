// Layer 4 — GET /api/v1/posts (PRD §20). Same filters, grouping, and response shape as /api/posts:
// both call runPostsQuery, so the agent sees exactly what the dashboard sees.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { runPostsQuery } from '@/lib/posts-query'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  return NextResponse.json(runPostsQuery(new URL(req.url).searchParams))
}
