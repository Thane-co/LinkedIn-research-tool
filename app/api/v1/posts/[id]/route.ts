// Layer 4 — GET /api/v1/posts/:id (PRD §20). One post, serialized like every other post (no vectors,
// no raw scraped payload).

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { getPostById } from '@/lib/db/posts.repo'
import { serializePost } from '@/lib/posts-query'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  const row = getPostById(params.id)
  if (!row) return NextResponse.json({ error: `No post with id ${params.id}` }, { status: 404 })
  return NextResponse.json({ post: serializePost(row) })
}
