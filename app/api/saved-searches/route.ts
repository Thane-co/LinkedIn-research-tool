// Layer 6 — GET/POST/DELETE /api/saved-searches (PRD §11.6). Named filter presets. Thin.

import { NextResponse } from 'next/server'
import { createSavedSearch, deleteSavedSearch, listSavedSearches } from '@/lib/db/saved-searches.repo'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ searches: listSavedSearches() })
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as { name?: string; params?: unknown }
  const name = body.name?.trim()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  createSavedSearch(name, body.params ?? {})
  return NextResponse.json({ searches: listSavedSearches() })
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  deleteSavedSearch(id)
  return NextResponse.json({ searches: listSavedSearches() })
}
