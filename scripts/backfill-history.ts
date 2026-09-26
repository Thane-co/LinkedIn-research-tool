// §8.6 cold-start backfill CLI — one-time job for roster creators with zero/insufficient
// pre-roster history, so x-factor can eventually score them. Follows the graduate-stuck.ts
// precedent: a tsx script driving the tested job directly.
//
//   npm run posts:backfill -- --dry-run              (report only, no Apify calls, no cost)
//   npm run posts:backfill -- --dry-run --max-posts 500
//   npm run posts:backfill                            (real run, default cap 1500 posts ≈ $3)
//   npm run posts:backfill -- --max-posts 300         (smaller Apify spend)
//
// This is a ONE-TIME backfill, not scheduled — run it once for the current cold-start cohort,
// then rely on the daily scrape + §8.5 graduation pass going forward.

import { backfillColdStartHistory } from '@/jobs/backfill-history'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const maxIdx = args.indexOf('--max-posts')
const maxPosts = maxIdx > -1 ? Number(args[maxIdx + 1]) : undefined
const perCreatorIdx = args.indexOf('--posts-per-creator')
const postsPerCreator = perCreatorIdx > -1 ? Number(args[perCreatorIdx + 1]) : undefined

backfillColdStartHistory({ dryRun, maxPosts, postsPerCreator })
  .then((res) => {
    if (res.errors.length > 0) process.exitCode = 1
  })
  .catch((err) => {
    console.error('backfill-history failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
