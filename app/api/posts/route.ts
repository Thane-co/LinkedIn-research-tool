// Layer 4 — GET /api/posts (PRD §11.1, §12 step 24). Thin: parse params -> repo/pure -> json.
// Paginated mode by default; grouping mode when groupByImage or discoverTrends is true (cap 400).
// TDD (integration, temp db): each filter; sort modes; hasMore exactness; grouping returns
// clusters; 400-cap respected.

import { NextResponse } from 'next/server'

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented — see PRD §11.1' }, { status: 501 })
}
