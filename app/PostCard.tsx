'use client'
// Layer 5 — PostCard (PRD §12 step 27): author, content (truncate/expand), engagement, platform
// badge, scrape-source badge, x-factor badge (>=2x green 🔥, 0.5-2x gray, <0.5x red), image, group size.

import { useState } from 'react'
import { xFactorBadge } from '@/lib/pure/badge'

export interface PostCardPost {
  id: string
  platform: 'linkedin' | 'twitter'
  url: string | null
  content: string | null
  author_name: string | null
  author_id?: string | null
  posted_at?: string | null
  likes: number
  comments: number
  shares: number
  x_factor: number | null
  scrape_source: 'keyword' | 'creator' | 'both' | null
  image_url: string | null
  imageGroupSize?: number
}

const TRUNCATE_AT = 280

/** "2026-06-26" → "Jun 26, 2026" (deterministic, locale-independent). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export function PostCard({
  post,
  selected = false,
  onToggleSelect,
  onAddAuthor,
}: {
  post: PostCardPost
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onAddAuthor?: (post: PostCardPost) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const content = post.content ?? ''
  const isLong = content.length > TRUNCATE_AT
  const shown = isLong && !expanded ? `${content.slice(0, TRUNCATE_AT)}…` : content

  const badge = xFactorBadge(post.x_factor)

  return (
    <article className="post-card">
      <header className="post-card__head">
        <input
          type="checkbox"
          className="post-card__select"
          aria-label={`select post by ${post.author_name ?? 'unknown'}`}
          checked={selected}
          onChange={() => onToggleSelect?.(post.id)}
        />
        <span className="post-card__author">{post.author_name ?? 'Unknown'}</span>
        {post.posted_at && <time className="post-card__date">{formatDate(post.posted_at)}</time>}
        <button
          type="button"
          className="post-card__add"
          aria-label={`add ${post.author_name ?? 'author'} to creators`}
          onClick={() => onAddAuthor?.(post)}
        >
          ＋
        </button>
        <span className={`badge badge--platform badge--${post.platform}`}>{post.platform}</span>
        {post.scrape_source && <span className="badge badge--source">{post.scrape_source}</span>}
        {badge.tone !== 'none' && (
          <span
            className={`badge badge--xfactor badge--${badge.tone}`}
            data-testid="xfactor-badge"
            data-tone={badge.tone}
          >
            {badge.emoji}
            {badge.label}
          </span>
        )}
      </header>

      {post.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="post-card__image" src={post.image_url} alt="" />
      )}

      <p className="post-card__content">{shown}</p>
      {isLong && (
        <button type="button" className="post-card__toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      <footer className="post-card__stats">
        <span className="stat" title="likes">
          👍 <b>{post.likes}</b>
        </span>
        <span className="stat" title="comments">
          💬 <b>{post.comments}</b>
        </span>
        <span className="stat" title="shares">
          🔁 <b>{post.shares}</b>
        </span>
        {post.imageGroupSize !== undefined && post.imageGroupSize > 1 && (
          <span className="post-card__group" data-testid="group-size">
            {post.imageGroupSize} similar
          </span>
        )}
      </footer>
    </article>
  )
}
