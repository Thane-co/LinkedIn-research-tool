// Layer 6 — GET/POST/DELETE /api/keywords (PRD §11.6). Per-market saved keyword sets. Thin.

import { NextResponse } from 'next/server'
import { addKeyword, deleteKeyword, deleteMarket, listKeywords } from '@/lib/db/keywords.repo'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ groups: listKeywords() })
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as { market?: string; term?: string }
  const market = body.market?.trim()
  const term = body.term?.trim()
  if (!market || !term) {
    return NextResponse.json({ error: 'market and term are required' }, { status: 400 })
  }
  addKeyword(market, term)
  return NextResponse.json({ groups: listKeywords() })
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams
  const id = sp.get('id')
  const market = sp.get('market')
  if (id) deleteKeyword(id)
  else if (market) deleteMarket(market)
  else return NextResponse.json({ error: 'id or market query param required' }, { status: 400 })
  return NextResponse.json({ groups: listKeywords() })
}
