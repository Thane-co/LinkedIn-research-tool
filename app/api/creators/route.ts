// Layer 4 — GET/POST/DELETE /api/creators (PRD §11.2, §12 step 23). Thin.
// TDD: add by url/handle, list+filter, delete.

import { NextResponse } from 'next/server'

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.2' }, { status: 501 })
}

export async function POST(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.2' }, { status: 501 })
}

export async function DELETE(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.2' }, { status: 501 })
}
