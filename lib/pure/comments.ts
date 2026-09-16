// Layer 0 — comment mapping and scrape selection for §23 (comments on her own posts). Zero I/O.
// 100% coverage required: a wrong post_id or parent link files a comment under the wrong thread.

import { extractActivityId } from '@/lib/pure/url'
import type { ApifyComment, CommentRow } from '@/lib/types'

// A comment urn names its post and itself: urn:li:comment:(activity:<post>,<comment>). Comment urls
// carry it percent-encoded in a query param, so both spellings of each separator are accepted — this
// never has to decode, and so can never throw on a malformed escape.
const COMMENT_URN = /urn(?::|%3A)li(?::|%3A)comment(?::|%3A)(?:\(|%28)activity(?::|%3A)(\d+)(?:,|%2C)(\d+)/i

/** The [postId, commentId] named by one urn-valued query param of a comment url, or null. */
function urnIn(url: string | undefined, param: 'commentUrn' | 'replyUrn'): [string, string] | null {
  const value = url?.match(new RegExp(`[?&]${param}=([^&]+)`))?.[1]
  const urn = value?.match(COMMENT_URN)
  return urn ? [urn[1]!, urn[2]!] : null
}

/**
 * The comment a reply answers. LinkedIn links a reply as `?commentUrn=<parent>&replyUrn=<reply>`, so a
 * url without a readable replyUrn is top-level (null), and a reply whose parent is unreadable is null
 * rather than a guessed thread.
 */
export function parentCommentId(url: string | undefined): string | null {
  return urnIn(url, 'replyUrn') ? (urnIn(url, 'commentUrn')?.[1] ?? null) : null
}

/**
 * The actor returns top-level comments as items and nests each one's replies in a `replies` array on
 * it (one level deep, verified 2026-09-15). Flatten to parent-then-replies so every reply becomes its
 * own row. The parent keeps everything but that array, because each reply is stored in its own right.
 */
export function flattenCommentItems(items: readonly ApifyComment[]): ApifyComment[] {
  return items.flatMap(({ replies, ...item }) => [
    item,
    ...(Array.isArray(replies) ? flattenCommentItems(replies as ApifyComment[]) : []),
  ])
}

/** Map one Apify comment to a row. Throws when no comment id or no post id can be derived. */
export function mapApifyCommentToRow(raw: ApifyComment, scrapedAt: string): CommentRow {
  const id = raw.id ?? urnIn(raw.linkedinUrl, 'replyUrn')?.[1] ?? urnIn(raw.linkedinUrl, 'commentUrn')?.[1]
  if (!id) throw new Error('mapApifyCommentToRow: could not derive a comment id from raw.id or url')

  const postId = extractActivityId(raw.postId) ?? extractActivityId(raw.linkedinUrl)
  if (!postId) throw new Error('mapApifyCommentToRow: could not derive a post id from postId or url')

  const actor = raw.actor
  const eng = raw.engagement
  return {
    id,
    post_id: postId,
    parent_comment_id: parentCommentId(raw.linkedinUrl),
    author_name: actor?.name ?? null,
    author_id: actor?.universalName ?? actor?.publicIdentifier ?? null,
    author_url: actor?.linkedinUrl ?? null,
    author_headline: actor?.position ?? null,
    author_type: actor?.type ?? null,
    is_post_author: actor?.author ? 1 : 0,
    text: raw.commentary ?? null,
    likes: eng?.likes ?? 0,
    replies: eng?.comments ?? 0,
    pinned: raw.pinned ? 1 : 0,
    edited: raw.edited ? 1 : 0,
    commented_at: raw.createdAt ?? null,
    scraped_at: scrapedAt,
    raw_data: JSON.stringify(raw),
  }
}

export interface PostToScrape {
  id: string
  author_id: string | null
  comments: number // LinkedIn's live comment count, from posts.comments
}

/**
 * Split candidate posts three ways. `refused`: not hers, never scraped. `upToDate`: every comment
 * LinkedIn reports is already stored, so re-reading would only pay again for the same rows (skipped
 * unless `force`). `scrape`: the rest.
 */
export function selectPostsToScrape(
  posts: readonly PostToScrape[],
  stored: ReadonlyMap<string, number>,
  opts: { ownAuthorId: string; force?: boolean },
): { scrape: string[]; upToDate: string[]; refused: string[] } {
  const out = { scrape: [] as string[], upToDate: [] as string[], refused: [] as string[] }
  for (const p of posts) {
    if (p.author_id !== opts.ownAuthorId) out.refused.push(p.id)
    else if (!opts.force && (stored.get(p.id) ?? 0) >= p.comments) out.upToDate.push(p.id)
    else out.scrape.push(p.id)
  }
  return out
}

export type SerializedComment = Omit<CommentRow, 'raw_data'>

/** A comment as served over the API: everything but the raw scraped payload. */
export function serializeComment(row: CommentRow): SerializedComment {
  const { raw_data: _raw, ...rest } = row
  return rest
}
