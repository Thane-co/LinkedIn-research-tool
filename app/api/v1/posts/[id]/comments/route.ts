// Layer 4 — GET /api/v1/posts/:id/comments (PRD §20, §23). The stored comments on one post (only the
// owner's own posts are ever scraped for them), serialized without the raw scraped payload.

import { NextResponse } from 'next/server'
import { requireReadToken } from '@/lib/api-readonly'
import { postCommentsView } from '@/lib/comments-query'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const blocked = requireReadToken(req)
  if (blocked) return blocked
  const view = postCommentsView(params.id)
  if (!view) return NextResponse.json({ error: `No post with id ${params.id}` }, { status: 404 })
  return NextResponse.json(view)
}
