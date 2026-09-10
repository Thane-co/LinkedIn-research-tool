// Layer 4 — GET/POST/DELETE /api/creators (PRD §11.2, §12 step 23). Thin.
// Platform detection / url normalization / author_id derivation happen here (route layer) via
// lib/pure/url.ts; storage + promote-on-re-add live in the creators repo.

import { NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { deleteCreator, listCreators, upsertCreator } from '@/lib/db/creators.repo'
import { getAuthorHistory } from '@/lib/db/posts.repo'
import { derivePersonaKey } from '@/lib/pure/persona'
import {
  extractInstagramHandle,
  extractLinkedInSlug,
  extractSubstackHandle,
  extractTwitterHandle,
  normalizeProfileUrl,
} from '@/lib/pure/url'
import type { Platform } from '@/lib/types'

// Reads/writes the live DB — never statically prerender/cache.
export const dynamic = 'force-dynamic'

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

  // Substack: URL-driven (§17.1). Canonicalize to the publication root so re-adds dedupe.
  if (/substack\.com/i.test(input)) {
    const handle = extractSubstackHandle(input)
    if (!handle) return null
    const profile_url = /substack\.com\/@/i.test(input)
      ? `https://substack.com/@${handle}`
      : `https://${handle}.substack.com`
    return { platform: 'substack', profile_url, author_id: handle }
  }

  // Instagram: URL-driven (§18). A bare @handle stays a Twitter handle, so only an instagram.com url
  // resolves. Canonicalize to the profile root so re-adds dedupe.
  if (/instagram\.com/i.test(input)) {
    const handle = extractInstagramHandle(input)
    if (!handle) return null
    return { platform: 'instagram', profile_url: `https://www.instagram.com/${handle}/`, author_id: handle }
  }

  // Twitter/X url or a bare @handle.
  const handle = extractTwitterHandle(input)
  if (!handle) return null
  return { platform: 'twitter', profile_url: `https://x.com/${handle}`, author_id: handle }
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url)
  const filter = {
    tag: url.searchParams.get('tag') ?? undefined,
    platform: (url.searchParams.get('platform') as Platform | null) ?? undefined,
  }
  return NextResponse.json(listCreators(filter))
}

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  const body = (await req.json()) as {
    input?: string
    inputs?: string[]
    tags?: string[]
    market?: string
    notes?: string
    persona?: string // §17.2 explicit person label; overrides the display-name auto-match
  }
  // An explicit persona (trimmed, non-empty) applies to every account in this request; when omitted,
  // each account's persona is auto-derived from its display name below.
  const manualPersona = body.persona?.trim() || undefined

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
    // §17.2: persona defaults to the display-name auto-match; a manual label wins. null when neither
    // resolves yet (fills in on a later re-add once the author has posts).
    const persona = manualPersona ?? derivePersonaKey(displayName)
    upsertCreator({
      platform: p.platform,
      profile_url: p.profile_url,
      author_id: p.author_id,
      display_name: displayName,
      persona,
      tags: body.tags,
      market: body.market,
      notes: body.notes ?? null,
    })
  }

  return NextResponse.json(listCreators())
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  deleteCreator(id)
  return NextResponse.json({ ok: true })
}
