// Layer 0 — extract a post's media from the raw Apify item (PRD §10.3.1). Zero I/O.
// Field names confirmed from real harvestapi/linkedin-post-search output:
//   raw.document  = { title, transcribedDocumentUrl, totalPageCount, coverPages: [{ imageUrls[] }] }
//   raw.postVideo = { videoUrl, thumbnailUrl }
//   raw.postImages = [{ url }]   (an array — carousels have >1)
// Precedence: document > video > image > none. The `thumbnail` is what the enrich job embeds and the
// card shows collapsed, so image-grouping (§9) spans images + document/video thumbnails uniformly.

import type { ApifyInstagramPost, ApifyPost, PostMedia } from '@/lib/types'

/** Runtime guard for a stored `media` value (JSON.parse output) — so a corrupt/legacy row that is
 *  valid JSON but the wrong shape is rejected (→ null) instead of trusted as a PostMedia. */
export function isPostMedia(v: unknown): v is PostMedia {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  switch (o.type) {
    case 'image':
      return Array.isArray(o.images) && o.images.every((i) => typeof i === 'string')
    case 'video':
      return typeof o.url === 'string' && (o.poster === null || typeof o.poster === 'string')
    case 'document':
      return (
        typeof o.url === 'string' &&
        (o.title === null || typeof o.title === 'string') &&
        (o.pages === null || typeof o.pages === 'number') &&
        (o.cover === null || typeof o.cover === 'string')
      )
    default:
      return false
  }
}

export function extractMedia(raw: ApifyPost): { media: PostMedia | null; thumbnail: string | null } {
  const doc = raw.document
  if (doc?.transcribedDocumentUrl) {
    const imageUrls = doc.coverPages?.[0]?.imageUrls ?? []
    const cover = imageUrls.length > 0 ? imageUrls[imageUrls.length - 1]! : null
    return {
      media: {
        type: 'document',
        url: doc.transcribedDocumentUrl,
        title: doc.title ?? null,
        pages: doc.totalPageCount ?? null,
        cover,
      },
      thumbnail: cover,
    }
  }

  const video = raw.postVideo
  if (video?.videoUrl) {
    const poster = video.thumbnailUrl ?? null
    return { media: { type: 'video', url: video.videoUrl, poster }, thumbnail: poster }
  }

  const images = (raw.postImages ?? []).map((i) => i.url).filter((u): u is string => !!u)
  if (images.length > 0) {
    return { media: { type: 'image', images }, thumbnail: images[0]! }
  }

  return { media: null, thumbnail: null }
}

/**
 * Instagram media (§18). Precedence: video > image(s) > none. A Video post carries `videoUrl` with
 * `displayUrl` as the poster; a carousel (Sidecar) fills `images[]`; a single-image post carries only
 * `displayUrl`. A Video with no `videoUrl` degrades to its poster image rather than yielding nothing.
 */
export function extractInstagramMedia(
  raw: ApifyInstagramPost,
): { media: PostMedia | null; thumbnail: string | null } {
  if (raw.type === 'Video' && raw.videoUrl) {
    const poster = raw.displayUrl ?? null
    return { media: { type: 'video', url: raw.videoUrl, poster }, thumbnail: poster }
  }

  const carousel = (raw.images ?? []).filter((u): u is string => !!u)
  const images = carousel.length > 0 ? carousel : raw.displayUrl ? [raw.displayUrl] : []
  if (images.length > 0) {
    return { media: { type: 'image', images }, thumbnail: images[0]! }
  }

  return { media: null, thumbnail: null }
}
