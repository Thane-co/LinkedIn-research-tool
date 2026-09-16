// Viral-window rescan (spec: content performance loop, Part 3).
//
// A 3-day rolling refresh: re-scrape the same recent window of every core LinkedIn creator daily, so
// a post that only blows up 30+ hours after going live still gets picked up. It drives the SAME job
// layer the /api/scrape route does (runScrape) — same insert/dedupe/x-factor pipeline — but headless,
// with no dev server, so the daily cron only needs a running SCRIPT, not a running server.
//
// After the scrape it prints a short summary of the freshest LinkedIn window (top by x_factor). A
// separate downstream consumer (a Hermes skill, not this repo) turns the same DB query into the
// actual morning brief — this script only makes sure the DB is fresh.
//
//   npm run scan:viral

import { runScrape } from '@/jobs/scrape'
import { getRecentViralLinkedIn } from '@/lib/db/posts.repo'
import { getSettings } from '@/lib/settings'
import type { PostRow, ScrapeStats } from '@/lib/types'

const HOUR_MS = 60 * 60 * 1000
const WINDOW_HOURS = 72 // matches the '3d' scrape timeframe
const TOP_N = 10

export async function run(): Promise<{ stats: ScrapeStats; posts: PostRow[] }> {
  // Reuse the exact app pipeline: creator mode, LinkedIn only, last 3 days, all core creators.
  const stats = await runScrape({
    mode: 'creator',
    platforms: ['linkedin'],
    timeframe: '3d',
    creatorIds: undefined,
    market: getSettings().default_market ?? 'ai',
  })

  const since = new Date(Date.now() - WINDOW_HOURS * HOUR_MS).toISOString()
  const posts = getRecentViralLinkedIn(since)

  console.log(
    `viral-window: scraped ${stats.inserted} new · ${posts.length} LinkedIn post(s) in the last ${WINDOW_HOURS}h`,
  )
  for (const p of posts.slice(0, TOP_N)) {
    const xf = p.x_factor === null ? '—' : p.x_factor.toFixed(2)
    console.log(`  x=${xf}  likes=${p.likes}  ${p.author_name ?? p.author_id ?? 'unknown'}  ${p.url ?? ''}`)
  }

  return { stats, posts }
}

// Thin bottom-of-file invocation so the file is unit-testable (import { run }) yet runnable directly.
// Guarded with typeof so importing the module under a test runner never triggers it.
if (typeof require !== 'undefined' && require.main === module) {
  run().catch((err) => {
    console.error('viral-window: fatal —', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
