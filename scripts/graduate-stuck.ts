// §8 graduation pass CLI — heals posts stuck provisional (measured only while young, then
// dropped out of the daily refresh window). Follows the daily-post-performance.ts precedent:
// a tsx script driving the tested job directly.
//
//   npm run posts:graduate               (default cap: 25 authors/run)
//   npm run posts:graduate -- --max 10   (smaller Apify spend)
//
// Scheduled after the daily refresh; a run with no stuck authors costs nothing.

import { graduateStuckPosts } from '@/jobs/graduate-stuck'

const maxIdx = process.argv.indexOf('--max')
const maxAuthors = maxIdx > -1 ? Number(process.argv[maxIdx + 1]) : undefined

graduateStuckPosts({ maxAuthors })
  .then((res) => {
    if (res.errors.length > 0) process.exitCode = 1
  })
  .catch((err) => {
    console.error('graduate-stuck failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
