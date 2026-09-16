'use client'
// Layer 5 — PostComments (§23): the comment thread under one of HER OWN post cards. Nothing loads until
// asked. "Show comments" reads what is stored; "Fetch comments" pays the actor to re-read this post
// (force, so edited text and new replies come in) and then shows the refreshed thread.

import { useState } from 'react'
import { apiFetch } from '@/lib/api-client'

export interface StoredComment {
  id: string
  parent_comment_id: string | null
  author_name: string | null
  author_headline: string | null
  is_post_author: number
  text: string | null
  likes: number
  commented_at: string | null
}

interface CommentsView {
  post_id: string
  total_on_linkedin: number
  comments: StoredComment[]
}

/**
 * Top-level comments in stored order, each followed by its replies. A reply whose parent was not stored
 * is shown at the top level rather than dropped: losing a comment is worse than mis-indenting it.
 */
function threaded(comments: StoredComment[]): { comment: StoredComment; reply: boolean }[] {
  const ids = new Set(comments.map((c) => c.id))
  const replies = new Map<string, StoredComment[]>()
  const top: StoredComment[] = []
  for (const c of comments) {
    if (c.parent_comment_id && ids.has(c.parent_comment_id)) {
      replies.set(c.parent_comment_id, [...(replies.get(c.parent_comment_id) ?? []), c])
    } else {
      top.push(c)
    }
  }
  return top.flatMap((c) => [
    { comment: c, reply: false },
    ...(replies.get(c.id) ?? []).map((r) => ({ comment: r, reply: true })),
  ])
}

export function PostComments({ postId }: { postId: string }) {
  const [view, setView] = useState<CommentsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load(fetchFresh: boolean) {
    setBusy(true)
    setError(null)
    try {
      if (fetchFresh) {
        await apiFetch<unknown>('/api/comments/scrape', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ postIds: [postId], force: true }),
        })
      }
      setView(await apiFetch<CommentsView>(`/api/posts/${encodeURIComponent(postId)}/comments`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load comments')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="post-card__comments" data-testid="comments">
      <div className="post-card__comments-head">
        <span className="post-card__transcript-label">💬 Comments</span>
        {view && (
          <span className="post-card__comments-count">
            {view.comments.length} of {view.total_on_linkedin} stored
          </span>
        )}
        <span className="post-card__comments-actions">
          {!view && (
            <button type="button" className="post-card__toggle" disabled={busy} onClick={() => void load(false)}>
              Show comments
            </button>
          )}
          <button type="button" className="post-card__toggle" disabled={busy} onClick={() => void load(true)}>
            {busy ? 'Working…' : 'Fetch comments'}
          </button>
        </span>
      </div>

      {error && (
        <p className="post-card__comments-error" role="alert">
          {error}
        </p>
      )}

      {view && view.comments.length === 0 && <p className="post-card__comments-empty">No comments stored yet.</p>}

      {view && view.comments.length > 0 && (
        <ul className="post-card__comments-list">
          {threaded(view.comments).map(({ comment, reply }) => (
            <li
              key={comment.id}
              className={reply ? 'post-card__comment post-card__comment--reply' : 'post-card__comment'}
              data-reply={reply ? 'true' : 'false'}
            >
              <span className="post-card__comment-author">
                {comment.author_name ?? 'Unknown'}
                {comment.is_post_author === 1 && <span className="badge badge--source">author</span>}
              </span>
              {comment.author_headline && <span className="post-card__comment-headline">{comment.author_headline}</span>}
              <p className="post-card__comment-text">{comment.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
