// Layer 4 — GET /api/v1/authors (PRD §20). The distinct authors present under the given post
// filters, so an agent can discover the author_id values to filter by.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { listAuthors } from '@/lib/posts-query'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  return NextResponse.json({ authors: listAuthors(new URL(req.url).searchParams) })
}
