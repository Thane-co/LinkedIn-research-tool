// Backfill script — recompute x-factor v2 for every author in `posts` (PRD §8, §6).
//
// The migration adds the new columns; this fills them. It walks every distinct author_id and calls
// recomputeXFactors in batches of 200 authors, each batch inside one transaction, logging progress
// and the total wall time. Most of the ~56k authors have under 5 mature posts and short-circuit to
// null scores, so the run is dominated by the few hundred creators with real history.
//
// Run with the repo's tsx convention (see package.json scripts, e.g. `npm run scan:viral`):
//   npx tsx scripts/recompute-xfactor.ts
//   DB_PATH=./research.db npx tsx scripts/recompute-xfactor.ts

import { getDb } from '@/lib/db/db'
import { recomputeXFactors } from '@/jobs/scrape'

const BATCH_SIZE = 200

export function recomputeAllXFactors(): { authors: number; rescored: number; ms: number } {
  const db = getDb()
  const started = Date.now()

  const authorIds = (
    db
      .prepare("SELECT DISTINCT author_id FROM posts WHERE author_id IS NOT NULL AND author_id <> ''")
      .all() as { author_id: string }[]
  ).map((r) => r.author_id)

  console.log(`recompute-xfactor: ${authorIds.length} distinct authors, batches of ${BATCH_SIZE}`)

  let rescored = 0
  let done = 0
  for (let i = 0; i < authorIds.length; i += BATCH_SIZE) {
    const batch = authorIds.slice(i, i + BATCH_SIZE)
    // One transaction per batch: a batch either fully commits or rolls back, and the whole run is not
    // one giant transaction that would hold a write lock for minutes.
    db.transaction(() => {
      rescored += recomputeXFactors(batch)
    })()
    done += batch.length
    const pct = Math.round((done / authorIds.length) * 100)
    console.log(`recompute-xfactor: ${done}/${authorIds.length} authors (${pct}%), ${rescored} posts rescored`)
  }

  const ms = Date.now() - started
  console.log(`recompute-xfactor: done — ${authorIds.length} authors, ${rescored} posts, ${(ms / 1000).toFixed(1)}s`)
  return { authors: authorIds.length, rescored, ms }
}

// Thin bottom-of-file invocation so the file is unit-testable (import { recomputeAllXFactors }) yet
// runnable directly. Guarded with typeof so importing under a test runner never triggers it.
if (typeof require !== 'undefined' && require.main === module) {
  try {
    recomputeAllXFactors()
  } catch (err) {
    console.error('recompute-xfactor: fatal —', err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}
