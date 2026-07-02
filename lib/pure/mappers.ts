// Layer 0 — Apify item -> PostRow mappers (PRD §10.3). Zero I/O. 100% coverage required.
// Invariants (CLAUDE.md): derive id from canonical URL urn (not raw.id); tweet ids prefixed
// 'tweet-'; match author on clean author_id, not author_url; throw on missing id.
//
// Language filtering (isLikelyNonEnglish) is applied by the scrape job (Layer 3), not here — the
// mapper is a pure, total mapping (map + throw-on-missing-id only).

import { extractMedia } from '@/lib/pure/media'
import { extractActivityId } from '@/lib/pure/url'
import type { ApifyPost, ApifyTweet, PostRow } from '@/lib/types'

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
