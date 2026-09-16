// Layer 2 — comment store for §23 (comments and replies on her own posts, PRD §6.9). Storage only:
// mapping lives in lib/pure/comments.ts and the own-post rule in jobs/scrape-comments.ts.

import { getDb } from '@/lib/db/db'
import type { CommentRow } from '@/lib/types'

const COLUMNS = `id, post_id, parent_comment_id, author_name, author_id, author_url, author_headline,
  author_type, is_post_author, text, likes, replies, pinned, edited, commented_at, scraped_at, raw_data`

// Upsert on id: a re-scrape refreshes edited text and new likes in place instead of duplicating.
const UPSERT = `INSERT INTO post_comments (${COLUMNS})
   VALUES (@id, @post_id, @parent_comment_id, @author_name, @author_id, @author_url, @author_headline,
     @author_type, @is_post_author, @text, @likes, @replies, @pinned, @edited, @commented_at, @scraped_at,
     @raw_data)
   ON CONFLICT(id) DO UPDATE SET
     post_id           = excluded.post_id,
     parent_comment_id = excluded.parent_comment_id,
     author_name       = excluded.author_name,
     author_id         = excluded.author_id,
     author_url        = excluded.author_url,
     author_headline   = excluded.author_headline,
     author_type       = excluded.author_type,
     is_post_author    = excluded.is_post_author,
     text              = excluded.text,
     likes             = excluded.likes,
     replies           = excluded.replies,
     pinned            = excluded.pinned,
     edited            = excluded.edited,
     commented_at      = excluded.commented_at,
     scraped_at        = excluded.scraped_at,
     raw_data          = excluded.raw_data`

/** Write a batch of comments in one transaction. Returns the number written. */
export function upsertComments(rows: CommentRow[]): number {
  if (rows.length === 0) return 0
  const stmt = getDb().prepare(UPSERT)
  getDb().transaction((batch: CommentRow[]) => {
    for (const r of batch) stmt.run(r)
  })(rows)
  return rows.length
}

/** One post's comments, oldest first (replies included; parent_comment_id threads them). */
export function getCommentsForPost(postId: string): CommentRow[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM post_comments WHERE post_id = ? ORDER BY commented_at ASC, id ASC`)
    .all(postId) as CommentRow[]
}

/** Stored comment count per post in ONE query. Posts with none are absent. */
export function countCommentsByPost(postIds: string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (postIds.length === 0) return out

  const rows = getDb()
    .prepare(
      `SELECT post_id, COUNT(*) AS n FROM post_comments
       WHERE post_id IN (${postIds.map(() => '?').join(',')}) GROUP BY post_id`,
    )
    .all(...postIds) as { post_id: string; n: number }[]

  for (const r of rows) out.set(r.post_id, r.n)
  return out
}
