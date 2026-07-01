// Layer 4 — GET/PUT /api/settings (PRD §11.4, §12 step 22). Thin.
// GET masks secret values (returns 'set'/'unset', never raw) + a `ready` summary.
// PUT upserts only the keys present (partial); trims; empty string clears.
// TDD: secrets masked on GET; partial PUT writes only given keys; `ready` reflects which keys set.

import { NextResponse } from 'next/server'

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.4' }, { status: 501 })
}

export async function PUT(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.4' }, { status: 501 })
}
