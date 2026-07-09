// Layer 0 — Apify item -> PostRow mappers (PRD §10.3). Zero I/O. 100% coverage required.
// Invariants (CLAUDE.md): derive id from canonical URL urn (not raw.id); tweet ids prefixed
// 'tweet-'; match author on clean author_id, not author_url; throw on missing id.
//
// Language filtering (isLikelyNonEnglish) is applied by the scrape job (Layer 3), not here — the
// mapper is a pure, total mapping (map + throw-on-missing-id only).

import { extractMedia } from '@/lib/pure/media'
import { extractActivityId } from '@/lib/pure/url'
import type { ApifyPost, ApifySubstackPost, ApifyTweet, PostRow } from '@/lib/types'

const nowIso = (): string => new Date().toISOString()

const blankEnrichment = {
  embedding: null,
  image_description: null,
  image_embedding: null,
  embedded_at: null,
  weighted_score: null,
  creator_baseline: null,
  x_factor: null,
} as const

/** LinkedIn: map a raw Apify post to a PostRow. Throws if no canonical id can be derived. */
export function mapApifyPostToRow(raw: ApifyPost, market: string): PostRow {
  const id = extractActivityId(raw.linkedinUrl) ?? raw.id
  if (!id) {
    throw new Error('mapApifyPostToRow: could not derive a post id from url or raw.id')
  }

  const eng = raw.engagement ?? undefined
  const { media, thumbnail } = extractMedia(raw)

  return {
    id,
    platform: 'linkedin',
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    content: raw.content ?? null,
    author_name: raw.author?.name ?? null,
    author_url: raw.author?.linkedinUrl ?? null,
    author_id: raw.author?.universalName ?? raw.author?.publicIdentifier ?? null,
    author_type: raw.author?.type ?? null,
    likes: eng?.likes ?? 0,
    shares: eng?.shares ?? 0,
    comments: eng?.comments ?? 0,
    posted_at: raw.postedAt?.date ?? null,
    scraped_at: nowIso(),
    is_repost: raw.repostedBy ? 1 : 0,
    scrape_source: null,
    market,
    media: media ? JSON.stringify(media) : null,
    image_url: thumbnail,
    raw_data: JSON.stringify(raw),
    ...blankEnrichment,
  }
}

/** Twitter: map a raw Apify tweet to a PostRow. id is prefixed 'tweet-'. Throws if raw.id missing. */
export function mapApifyTweetToRow(raw: ApifyTweet, market: string): PostRow {
  if (!raw.id) {
    throw new Error('mapApifyTweetToRow: missing tweet id')
  }
  const handle = raw.author?.userName ?? null

  return {
    id: `tweet-${raw.id}`,
    platform: 'twitter',
    url: raw.url ?? raw.twitterUrl ?? null,
    content: raw.text ?? null,
    author_name: handle,
    author_url: handle ? `https://x.com/${handle}` : null,
    author_id: handle,
    author_type: raw.author?.isBlueVerified ? 'verified' : 'profile',
    likes: raw.likeCount ?? 0,
    shares: raw.retweetCount ?? 0,
    comments: raw.replyCount ?? 0,
    posted_at: new Date(raw.createdAt).toISOString(),
    scraped_at: nowIso(),
    is_repost: raw.isRetweet ? 1 : 0,
    scrape_source: null,
    market,
    media: null, // Twitter media mapping pending a real tweet payload (PRD §10.3)
    image_url: null,
    raw_data: JSON.stringify(raw),
    ...blankEnrichment,
  }
}

/** Parse a date to an ISO-8601 UTC string, or null if absent/unparseable (never throws). */
function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * True only for Substack records that are actual content (a post/article or a note). The actor also
 * emits `type:'author'` and `type:'publication'` metadata records (e.g. when `userHandles` is set),
 * which carry no post and must be skipped — otherwise they land as blank "Unknown" cards (§17).
 */
export function isSubstackContent(raw: ApifySubstackPost): boolean {
  const t = raw.type
  return t === undefined || t === 'post' || t === 'note'
}

/**
 * A note is worth storing only if it carries something displayable: body text, an image attachment,
 * or a restacked article. The actor returns some notes completely empty (a Substack-rendered quote
 * card with no scraped body/image) — those become blank cards, so the scrape skips them (§17).
 */
export function substackNoteHasContent(raw: ApifySubstackPost): boolean {
  return (
    !!(raw.body && raw.body.trim()) ||
    (raw.attachmentUrls?.length ?? 0) > 0 ||
    !!raw.restackedPost ||
    !!raw.restackedPublication
  )
}

/**
 * Substack Note: map a raw note record to a PostRow (§17). id prefixed 'substack-note-'. Field names
 * confirmed from a real run: authorHandle/authorName, body, createdAt, reactionCount, attachmentUrls.
 * Notes have no comment/restack counts (only reactions); an image-only note has an empty body.
 */
function mapSubstackNoteToRow(raw: ApifySubstackPost, market: string): PostRow {
  if (raw.id === undefined || raw.id === null || raw.id === '') {
    throw new Error('mapApifySubstackToRow: note missing id')
  }
  const handle = raw.authorHandle ?? null
  const images = (raw.attachmentUrls ?? []).filter((u): u is string => !!u)
  // A note keeps its OWN url (always unique). A restacked article's url would collide with that same
  // article scraped as a post (unique-url index), so we never use it as the row url.
  const noteUrl = handle ? `https://substack.com/@${handle}/note/c-${raw.id}` : null
  // A restack note has no body — surface the boosted article's title instead.
  const content = raw.body && raw.body.trim() ? raw.body : (raw.restackedPost?.title ?? null)

  return {
    id: `substack-note-${raw.id}`,
    platform: 'substack',
    url: noteUrl,
    content,
    author_name: raw.authorName ?? handle,
    author_url: handle ? `https://substack.com/@${handle}` : null,
    author_id: handle,
    author_type: 'profile',
    likes: raw.reactionCount ?? 0,
    shares: 0, // notes carry no restack/comment counts
    comments: 0,
    posted_at: toIsoOrNull(raw.createdAt),
    scraped_at: nowIso(),
    is_repost: raw.kind === 'restack' ? 1 : 0, // a restack note boosts someone else's post
    scrape_source: null,
    market,
    media: images.length ? JSON.stringify({ type: 'image', images }) : null,
    image_url: images[0] ?? null,
    raw_data: JSON.stringify(raw),
    ...blankEnrichment,
  }
}

/** Substack: map a raw record to a PostRow. Handles both posts/articles and Notes (type:'note').
 *  id is prefixed 'substack-'. Throws when no id/slug can be derived. */
export function mapApifySubstackToRow(raw: ApifySubstackPost, market: string): PostRow {
  if (raw.type === 'note') return mapSubstackNoteToRow(raw, market)
  const key = raw.id ?? raw.slug
  if (key === undefined || key === null || key === '') {
    throw new Error('mapApifySubstackToRow: missing post id and slug')
  }
  const handle = raw.publicationHandle ?? null
  const cover = raw.coverImage ?? null
  const content = [raw.title, raw.subtitle, raw.bodyMarkdown].filter(Boolean).join('\n\n') || null

  return {
    id: `substack-${key}`,
    platform: 'substack',
    url: raw.url ?? null,
    content,
    author_name: raw.author?.name ?? raw.publicationName ?? handle,
    author_url: raw.publicationUrl ?? (handle ? `https://${handle}.substack.com` : null),
    author_id: handle,
    author_type: 'profile',
    likes: raw.reactionCount ?? 0,
    shares: raw.restackCount ?? 0,
    comments: raw.commentCount ?? 0,
    posted_at: toIsoOrNull(raw.publishedAt),
    scraped_at: nowIso(),
    is_repost: 0,
    scrape_source: null,
    market,
    media: cover ? JSON.stringify({ type: 'image', images: [cover] }) : null,
    image_url: cover,
    raw_data: JSON.stringify(raw),
    ...blankEnrichment,
  }
}
