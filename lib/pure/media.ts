// Layer 0 — extract a post's media from the raw Apify item (PRD §10.3.1). Zero I/O.
// Field names confirmed from real harvestapi/linkedin-post-search output:
//   raw.document  = { title, transcribedDocumentUrl, totalPageCount, coverPages: [{ imageUrls[] }] }
//   raw.postVideo = { videoUrl, thumbnailUrl }
//   raw.postImages = [{ url }]   (an array — carousels have >1)
// Precedence: document > video > image > none. The `thumbnail` is what the enrich job embeds and the
// card shows collapsed, so image-grouping (§9) spans images + document/video thumbnails uniformly.

import type { ApifyPost, PostMedia } from '@/lib/types'

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
