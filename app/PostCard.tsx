'use client'
// Layer 5 — PostCard (PRD §12 step 27): author + date, a link to the original post, platform badge;
// content (truncate/expand); optional image; footer with engagement (👍/💬/🔁) and — on the right —
// the scrape-source badge + x-factor badge (>=2x green 🔥, 0.5-2x gray, <0.5x red) + group size.
// §23: on her OWN LinkedIn posts (author_id === the own author id) the card also carries the comments.

import { useContext, useState } from 'react'
import { OwnAuthorContext } from '@/app/OwnAuthor'
import { PostComments } from '@/app/PostComments'
import { xFactorBadge } from '@/lib/pure/badge'
import { isExpiredMediaUrl, mediaProxySrc, safeHref } from '@/lib/pure/url'
import type { PostMedia } from '@/lib/types'

export interface PostCardPost {
  id: string
  platform: 'linkedin' | 'twitter' | 'substack' | 'instagram'
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
  media?: PostMedia | null
  transcript?: string | null // §18: speech-to-text of a video post, shown under the caption
}

/**
 * One post image, degrading to a placeholder rather than a broken-image icon (§10.3.2).
 *
 * Two ways an image dies, handled differently:
 *  • PREDICTABLE — the url is signed and its expiry has passed, so it is a permanent 403. Skipped
 *    without rendering an <img> at all, which also spares a doomed round trip through /api/media.
 *    Most of this corpus is in that state.
 *  • UNPREDICTABLE — an unsigned url that has since died, a deleted local file, a dead host. Nothing
 *    to read offline, so it is attempted and `onError` catches the failure.
 *
 * The placeholder is deliberately not "render nothing": for content research, whether a post carried
 * an image is itself a finding, and silently dropping it would make an image post read as text-only.
 */
function PostImage({ src, alt, className }: { src: string | null | undefined; alt: string; className: string }) {
  const [failed, setFailed] = useState(false)
  const proxied = mediaProxySrc(src)
  if (!proxied) return null
  if (failed || isExpiredMediaUrl(src)) {
    return (
      <span
        className={`${className} post-card__image--unavailable`}
        role="img"
        aria-label="image no longer available"
        title="the platform's signed link for this image has expired"
      >
        🖼
      </span>
    )
  }
  return (
    <img className={className} src={proxied} alt={alt} onError={() => setFailed(true)} />
  )
}

/* eslint-disable @next/next/no-img-element */
/** Render the post's media by type (§10.3.1); falls back to a single image_url image. */
function PostMediaView({ post }: { post: PostCardPost }) {
  const m = post.media
  if (m?.type === 'image') {
    if (m.images.length <= 1) {
      return <PostImage className="post-card__image" src={m.images[0]} alt="post media" />
    }
    return (
      <div className="post-card__carousel" data-testid="carousel">
        {m.images.map((src, i) => (
          <PostImage
            key={i}
            className="post-card__image post-card__carousel-item"
            src={src}
            alt="post media"
          />
        ))}
        <span className="post-card__media-count">{m.images.length} images</span>
      </div>
    )
  }
  if (m?.type === 'video') {
    return (
      <a
        className="post-card__media-link post-card__video"
        data-testid="video-media"
        href={safeHref(post.url ?? m.url)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="play the video (opens the post)"
      >
        <PostImage className="post-card__image" src={m.poster} alt="video thumbnail" />
        <span className="post-card__play" aria-hidden="true">
          ▶
        </span>
      </a>
    )
  }
  if (m?.type === 'document') {
    return (
      <a
        className="post-card__media-link post-card__document"
        data-testid="document-media"
        href={safeHref(m.url)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <PostImage className="post-card__image" src={m.cover} alt={m.title ?? 'document'} />
        <span className="badge post-card__doc-badge">📄 {m.pages ?? '?'} pages</span>
      </a>
    )
  }
  // fallback: a legacy/thumbnail-only post
  return <PostImage className="post-card__image" src={post.image_url} alt="post media" />
}
/* eslint-enable @next/next/no-img-element */

const TRUNCATE_AT = 280

/** "2026-06-26" → "Jun 26, 2026" (deterministic, locale-independent). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export function PostCard({ post, ownAuthorId }: { post: PostCardPost; ownAuthorId?: string | null }) {
  // An explicit prop wins; otherwise the app shell's setting (§23). Neither = no comments anywhere.
  const contextOwnAuthor = useContext(OwnAuthorContext)
  const ownAuthor = ownAuthorId ?? contextOwnAuthor
  const [expanded, setExpanded] = useState(false)
  const [transcriptExpanded, setTranscriptExpanded] = useState(false)
  const content = post.content ?? ''
  const isLong = content.length > TRUNCATE_AT
  const shown = isLong && !expanded ? `${content.slice(0, TRUNCATE_AT)}…` : content

  const transcript = post.transcript?.trim() ?? ''
  const transcriptLong = transcript.length > TRUNCATE_AT
  const transcriptShown = transcriptLong && !transcriptExpanded ? `${transcript.slice(0, TRUNCATE_AT)}…` : transcript

  const badge = xFactorBadge(post.x_factor)
  const isOwnPost = post.platform === 'linkedin' && Boolean(ownAuthor) && post.author_id === ownAuthor

  return (
    <article className="post-card">
      <header className="post-card__head">
        <span className="post-card__author">{post.author_name ?? 'Unknown'}</span>
        {post.posted_at && <time className="post-card__date">{formatDate(post.posted_at)}</time>}
        <span className="post-card__head-right">
          {safeHref(post.url) && (
            <a
              className="post-card__link"
              href={safeHref(post.url)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="open the original post"
              title="Open the original post"
            >
              🔗
            </a>
          )}
          <span className={`badge badge--platform badge--${post.platform}`}>{post.platform}</span>
        </span>
      </header>

      <PostMediaView post={post} />

      <p className="post-card__content">{shown}</p>
      {isLong && (
        <button type="button" className="post-card__toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      {transcript && (
        <section className="post-card__transcript" data-testid="transcript">
          <div className="post-card__transcript-head">
            <span className="post-card__transcript-label">🎬 Video transcript</span>
          </div>
          <p className="post-card__transcript-text">{transcriptShown}</p>
          {transcriptLong && (
            <button
              type="button"
              className="post-card__toggle"
              onClick={() => setTranscriptExpanded((e) => !e)}
            >
              {transcriptExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </section>
      )}

      {isOwnPost && <PostComments postId={post.id} />}

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

        <span className="post-card__badges">
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
        </span>
      </footer>
    </article>
  )
}
