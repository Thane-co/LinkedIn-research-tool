// Layer 4 — GET/POST/DELETE /api/creators (PRD §11.2, §12 step 23). Thin.
// Platform detection / url normalization / author_id derivation happen here (route layer) via
// lib/pure/url.ts; storage + promote-on-re-add live in the creators repo.

import { NextResponse } from 'next/server'
import { deleteCreator, listCreators, setCreatorTier, upsertCreator } from '@/lib/db/creators.repo'
import { getAuthorHistory } from '@/lib/db/posts.repo'
import { extractLinkedInSlug, extractTwitterHandle, normalizeProfileUrl } from '@/lib/pure/url'
import type { CreatorTier, Platform } from '@/lib/types'

interface ParsedCreator {
  platform: Platform
  profile_url: string
  author_id: string | null
}

/** Detect platform, normalize the url, and derive the clean author_id (PRD §11.2). */
function parseCreatorInput(raw: string): ParsedCreator | null {
  const input = raw.trim()
  if (!input) return null

  if (/linkedin\.com/i.test(input)) {
    const profile_url = normalizeProfileUrl(input)
    return { platform: 'linkedin', profile_url, author_id: extractLinkedInSlug(profile_url) }
  }

  // Twitter/X url or a bare @handle.
  const handle = extractTwitterHandle(input)
  if (!handle) return null
  return { platform: 'twitter', profile_url: `https://x.com/${handle}`, author_id: handle }
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url)
  const filter = {
    tier: (url.searchParams.get('tier') as CreatorTier | null) ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    platform: (url.searchParams.get('platform') as Platform | null) ?? undefined,
  }
  return NextResponse.json(listCreators(filter))
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as {
    input?: string
    inputs?: string[]
    tier?: CreatorTier
    tags?: string[]
    market?: string
    notes?: string
  }

  // Accept one or many; a single field may itself hold newline/comma-separated entries.
  const rawInputs = [...(body.inputs ?? []), ...(body.input ? [body.input] : [])].flatMap((s) =>
    s.split(/[\n,]/),
  )
  const parsed = rawInputs.map(parseCreatorInput).filter((p): p is ParsedCreator => p !== null)

  if (parsed.length === 0) {
    return NextResponse.json({ error: 'No valid creator url or @handle supplied' }, { status: 400 })
  }

  for (const p of parsed) {
    // Auto-fill display_name from any existing post by that author (posts carry no avatar).
    const displayName = p.author_id ? (getAuthorHistory(p.author_id)[0]?.author_name ?? null) : null
    upsertCreator({
      platform: p.platform,
      profile_url: p.profile_url,
      author_id: p.author_id,
      display_name: displayName,
      tier: body.tier,
      tags: body.tags,
      market: body.market,
      notes: body.notes ?? null,
    })
  }

  return NextResponse.json(listCreators())
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as { id?: string; tier?: CreatorTier }
  if (!body.id || (body.tier !== 'core' && body.tier !== 'watch')) {
    return NextResponse.json({ error: 'id and tier ("core"|"watch") required' }, { status: 400 })
  }
  setCreatorTier(body.id, body.tier) // explicit promote/demote (never silent)
  return NextResponse.json(listCreators())
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  deleteCreator(id)
  return NextResponse.json({ ok: true })
}
