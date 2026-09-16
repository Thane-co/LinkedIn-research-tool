// Layer 3 — scrapeOwnPostComments: pull every comment and reply on HER OWN LinkedIn posts and store
// them against the post (PRD §23).
//
// THE OWN-POST RULE is enforced here, before the actor is ever called: a post counts only when its
// stored author_id equals the own_linkedin_author_id setting. An explicit request naming any other post,
// or a post id that was never stored (whose author cannot be checked), is refused whole with
// NotOwnPostError, so a mixed list never half-runs. A comment the actor returns for a post that was not
// asked for is dropped, not stored.
//
// COST: the actor bills per comment returned, and a re-read pays for every comment again. A post whose
// stored count already covers LinkedIn's count is skipped unless `force` is set.
//
// A failed batch is logged and skipped, never fatal, as in §22.

import { buildLinkedInCommentsInput, runActor } from '@/lib/apify'
import { COMMENT_SCRAPE_COST_PER_COMMENT, COMMENTS_WINDOW_DAYS } from '@/lib/config'
import { countCommentsByPost, upsertComments } from '@/lib/db/comments.repo'
import { getAuthorHistory, getPostsByIds } from '@/lib/db/posts.repo'
import { flattenCommentItems, mapApifyCommentToRow, selectPostsToScrape } from '@/lib/pure/comments'
import { getKey } from '@/lib/settings'
import type { ApifyComment, CommentRow, PostRow } from '@/lib/types'

const DEFAULT_BATCH_SIZE = 10
const DAY_MS = 24 * 60 * 60 * 1000

/** Thrown when a caller names a post that is not hers (or not stored). Nothing has been spent. */
export class NotOwnPostError extends Error {
  readonly postIds: string[]

  constructor(postIds: string[]) {
    super(`Refusing to scrape comments on posts that are not yours: ${postIds.join(', ')}`)
    this.name = 'NotOwnPostError'
    this.postIds = postIds
  }
}

export interface CommentScrapeOptions {
  postIds?: string[] // specific posts, at any age; omitted = her posts inside the window
  days?: number // the window for an omitted postIds (default COMMENTS_WINDOW_DAYS)
  force?: boolean // re-read posts whose comments already look fully stored
  now?: string // ISO instant; defaults to the current time
  batchSize?: number
}

export interface CommentScrapeResult {
  posts_considered: number
  posts_scraped: number
  up_to_date: number
  comments_returned: number
  stored: number
  dropped: number
  cost_usd: number
  errors: string[]
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const postUrl = (p: PostRow): string => p.url ?? `https://www.linkedin.com/feed/update/urn:li:activity:${p.id}/`

// Newest first (the posts still collecting comments), ties by id, so batch order never depends on
// how SQLite happens to return equal timestamps.
const newestFirst = (a: PostRow, b: PostRow): number =>
  (b.posted_at ?? '').localeCompare(a.posted_at ?? '') || a.id.localeCompare(b.id)

/** The posts a run covers. Throws NotOwnPostError when an explicit id is not hers. */
function candidatePosts(ownAuthorId: string, opts: CommentScrapeOptions, now: string): PostRow[] {
  if (opts.postIds) {
    const found = getPostsByIds(opts.postIds)
    const mine = new Set(found.filter((p) => p.author_id === ownAuthorId).map((p) => p.id))
    const refused = opts.postIds.filter((id) => !mine.has(id))
    if (refused.length > 0) throw new NotOwnPostError(refused)
    return found.sort(newestFirst)
  }
  const since = new Date(Date.parse(now) - (opts.days ?? COMMENTS_WINDOW_DAYS) * DAY_MS).toISOString()
  return getAuthorHistory(ownAuthorId)
    .filter((p) => p.platform === 'linkedin' && p.posted_at !== null && p.posted_at >= since)
    .sort(newestFirst)
}

/**
 * Scrape and store the comments on her own posts. Throws when her author id or the comments actor is
 * not configured, and NotOwnPostError for someone else's post; a failed batch is reported, not thrown.
 */
export async function scrapeOwnPostComments(opts: CommentScrapeOptions = {}): Promise<CommentScrapeResult> {
  const ownAuthorId = getKey('own_linkedin_author_id')
  if (!ownAuthorId) {
    throw new Error(
      'scrapeOwnPostComments: set own_linkedin_author_id in Settings first — comments are only scraped for your own posts',
    )
  }
  const actorId = getKey('apify_comments_actor_id')
  if (!actorId) {
    throw new Error('scrapeOwnPostComments: no comments actor configured — set apify_comments_actor_id in Settings')
  }

  const now = opts.now ?? new Date().toISOString()
  const posts = candidatePosts(ownAuthorId, opts, now)
  const byId = new Map(posts.map((p) => [p.id, p]))
  // The pure rule runs even though candidatePosts already filtered: one definition of "hers" decides.
  const plan = selectPostsToScrape(posts, countCommentsByPost(posts.map((p) => p.id)), {
    ownAuthorId,
    force: opts.force,
  })

  const result: CommentScrapeResult = {
    posts_considered: posts.length,
    posts_scraped: 0,
    up_to_date: plan.upToDate.length,
    comments_returned: 0,
    stored: 0,
    dropped: 0,
    cost_usd: 0,
    errors: [],
  }

  for (const batch of chunk(plan.scrape, opts.batchSize ?? DEFAULT_BATCH_SIZE)) {
    let items: ApifyComment[]
    try {
      items = (await runActor(
        actorId,
        buildLinkedInCommentsInput(batch.map((id) => postUrl(byId.get(id)!))),
      )) as ApifyComment[]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`scrapeOwnPostComments: batch of ${batch.length} post(s) failed — ${message}`)
      result.errors.push(`batch of ${batch.length}: ${message}`)
      continue
    }

    result.posts_scraped += batch.length
    // Billed per top-level item; the replies nested inside them are stored but not counted here.
    result.comments_returned += items.length

    const requested = new Set(batch)
    const rows: CommentRow[] = []
    for (const item of flattenCommentItems(items)) {
      try {
        const row = mapApifyCommentToRow(item, now)
        if (requested.has(row.post_id)) {
          rows.push(row)
        } else {
          result.dropped += 1
          console.error(`scrapeOwnPostComments: dropped comment ${row.id} on post ${row.post_id}, which was not requested`)
        }
      } catch (err) {
        result.dropped += 1
        console.error(`scrapeOwnPostComments: unmappable comment — ${err instanceof Error ? err.message : err}`)
      }
    }
    result.stored += upsertComments(rows)
  }

  result.cost_usd = result.comments_returned * COMMENT_SCRAPE_COST_PER_COMMENT
  console.log(
    `scrapeOwnPostComments: ${result.posts_scraped} of ${result.posts_considered} post(s) read ` +
      `(${result.up_to_date} up to date), ${result.stored} comments stored, ${result.dropped} dropped, ` +
      `$${result.cost_usd.toFixed(2)}, ${result.errors.length} batch error(s)`,
  )
  return result
}
