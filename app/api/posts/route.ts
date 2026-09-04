// Layer 4 — GET /api/posts (PRD §11.1, §12 step 24). Thin: the filter parsing, querying, grouping,
// and serialization all live in lib/posts-query.ts, shared with the read-only agent API (§20).

import { NextResponse } from 'next/server'
import { runPostsQuery } from '@/lib/posts-query'

// Reads the live DB — never statically prerender/cache.
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  return NextResponse.json(runPostsQuery(new URL(req.url).searchParams))
}
