// Temporary tab: discover a creator's last-7-days Instagram video posts via the same
// apify/instagram-post-scraper actor + settings the main tool uses, so both comparison panels
// below research the identical post set. Runs once, shared by both panels.
import { NextResponse } from 'next/server'
import { buildInstagramCreatorInput, runActor } from '@/lib/apify'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { SETTINGS_DEFAULTS } from '@/lib/config'
import { discoveryCost } from '@/lib/ig-compare/pricing'
import type { DiscoverResponse, DiscoveredPost } from '@/lib/ig-compare/types'
import { getSettings } from '@/lib/settings'
import type { ApifyInstagramPost } from '@/lib/types'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked

  const { username, limit } = (await req.json().catch(() => ({}))) as { username?: string; limit?: number }
  if (!username) return NextResponse.json({ error: 'username is required' }, { status: 400 })
  const resultsLimit = limit && limit > 0 ? limit : 5

  const start = Date.now()
  const actorId = getSettings().apify_instagram_actor_id ?? SETTINGS_DEFAULTS.apify_instagram_actor_id
  const onlyNewerThan = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10)

  let raw: ApifyInstagramPost[]
  try {
    raw = (await runActor(
      actorId,
      buildInstagramCreatorInput([username], 'week', { onlyNewerThan }),
    )) as ApifyInstagramPost[]
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }

  const videos = raw
    .filter((p): p is ApifyInstagramPost & { videoUrl: string } => p.type === 'Video' && !!p.videoUrl)
    .slice(0, resultsLimit)

  const posts: DiscoveredPost[] = videos.map((v) => ({
    shortCode: v.shortCode ?? v.id ?? '',
    postUrl: v.url ?? '',
    videoUrl: v.videoUrl,
    thumbnail: v.displayUrl ?? null,
    caption: v.caption ?? null,
  }))

  const body: DiscoverResponse = {
    elapsedMs: Date.now() - start,
    estimatedCostUsd: discoveryCost(posts.length),
    posts,
  }
  return NextResponse.json(body)
}
