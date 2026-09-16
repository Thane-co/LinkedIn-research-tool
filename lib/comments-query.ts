// Layer 3 — one post's stored comment thread (§23). The single implementation behind both
// GET /api/posts/[id]/comments and GET /api/v1/posts/{id}/comments, as runPostsQuery() is for §20.

import { getCommentsForPost } from '@/lib/db/comments.repo'
import { getPostById } from '@/lib/db/posts.repo'
import { serializeComment, type SerializedComment } from '@/lib/pure/comments'

export interface PostCommentsView {
  post_id: string
  total_on_linkedin: number // LinkedIn's live count, so a partial stored set reads as partial
  comments: SerializedComment[] // oldest first; parent_comment_id threads the replies
}

/** null when the post itself is unknown (a 404); an empty list when its comments were never scraped. */
export function postCommentsView(postId: string): PostCommentsView | null {
  const post = getPostById(postId)
  if (!post) return null
  return {
    post_id: post.id,
    total_on_linkedin: post.comments,
    comments: getCommentsForPost(post.id).map(serializeComment),
  }
}
