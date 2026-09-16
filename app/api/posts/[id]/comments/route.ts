// Layer 4 — GET /api/posts/[id]/comments (§23). The stored comment thread for one post, with
// LinkedIn's own count alongside so a partial set reads as partial. Read-only; thin.

import { NextResponse } from 'next/server'
import { postCommentsView } from '@/lib/comments-query'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const view = postCommentsView(params.id)
  if (!view) return NextResponse.json({ error: `No post with id ${params.id}` }, { status: 404 })
  return NextResponse.json(view)
}
