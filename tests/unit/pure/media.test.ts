import { describe, expect, it } from 'vitest'
import { extractInstagramMedia, extractMedia, isPostMedia } from '@/lib/pure/media'
import type { ApifyInstagramPost, ApifyPost } from '@/lib/types'

describe('extractMedia', () => {
  it('extracts a single image and uses it as the thumbnail', () => {
    const raw = { postImages: [{ url: 'https://img/1.png' }] } as ApifyPost
    expect(extractMedia(raw)).toEqual({
      media: { type: 'image', images: ['https://img/1.png'] },
      thumbnail: 'https://img/1.png',
    })
  })

  it('extracts a carousel (multiple images), thumbnail = first', () => {
    const raw = { postImages: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] } as ApifyPost
    expect(extractMedia(raw)).toEqual({
      media: { type: 'image', images: ['a', 'b', 'c'] },
      thumbnail: 'a',
    })
  })

  it('extracts a video (poster is the thumbnail); video wins over stray images', () => {
    const raw = {
      postVideo: { videoUrl: 'https://vid/stream', thumbnailUrl: 'https://vid/poster.jpg' },
      postImages: [],
    } as unknown as ApifyPost
    expect(extractMedia(raw)).toEqual({
      media: { type: 'video', url: 'https://vid/stream', poster: 'https://vid/poster.jpg' },
      thumbnail: 'https://vid/poster.jpg',
    })
  })

  it('extracts a document (cover = last coverPage image), thumbnail = cover; document wins', () => {
    const raw = {
      document: {
        title: 'Google New SDLC',
        transcribedDocumentUrl: 'https://doc/pdf',
        totalPageCount: 51,
        coverPages: [{ imageUrls: ['low.jpg', 'mid.jpg', 'high.jpg'] }],
      },
      postVideo: { videoUrl: 'v', thumbnailUrl: 't' },
      postImages: [{ url: 'x' }],
    } as unknown as ApifyPost
    expect(extractMedia(raw)).toEqual({
      media: { type: 'document', url: 'https://doc/pdf', title: 'Google New SDLC', pages: 51, cover: 'high.jpg' },
      thumbnail: 'high.jpg',
    })
  })

  it('handles a document missing title/pages/cover gracefully', () => {
    const raw = { document: { transcribedDocumentUrl: 'https://doc/pdf' } } as unknown as ApifyPost
    expect(extractMedia(raw)).toEqual({
      media: { type: 'document', url: 'https://doc/pdf', title: null, pages: null, cover: null },
      thumbnail: null,
    })
  })

  it('handles a video with no poster', () => {
    const raw = { postVideo: { videoUrl: 'https://vid/stream' } } as unknown as ApifyPost
    expect(extractMedia(raw)).toEqual({
      media: { type: 'video', url: 'https://vid/stream', poster: null },
      thumbnail: null,
    })
  })

  it('returns { null, null } when there is no media (empty images, no video/doc)', () => {
    expect(extractMedia({ postImages: [] } as ApifyPost)).toEqual({ media: null, thumbnail: null })
    expect(extractMedia({} as ApifyPost)).toEqual({ media: null, thumbnail: null })
  })

  it('skips images with no url', () => {
    const raw = { postImages: [{}, { url: 'b' }] } as ApifyPost
    expect(extractMedia(raw)).toEqual({ media: { type: 'image', images: ['b'] }, thumbnail: 'b' })
  })
})

describe('extractInstagramMedia (§18)', () => {
  it('extracts a single image from displayUrl, thumbnail = it', () => {
    const raw = { type: 'Image', displayUrl: 'https://ig/img.jpg', images: [] } as unknown as ApifyInstagramPost
    expect(extractInstagramMedia(raw)).toEqual({
      media: { type: 'image', images: ['https://ig/img.jpg'] },
      thumbnail: 'https://ig/img.jpg',
    })
  })

  it('extracts a carousel (Sidecar) from the images array, thumbnail = first', () => {
    const raw = { type: 'Sidecar', displayUrl: 'a', images: ['a', 'b', 'c'] } as unknown as ApifyInstagramPost
    expect(extractInstagramMedia(raw)).toEqual({
      media: { type: 'image', images: ['a', 'b', 'c'] },
      thumbnail: 'a',
    })
  })

  it('extracts a video (poster = displayUrl); video wins', () => {
    const raw = {
      type: 'Video',
      videoUrl: 'https://ig/reel.mp4',
      displayUrl: 'https://ig/poster.jpg',
    } as unknown as ApifyInstagramPost
    expect(extractInstagramMedia(raw)).toEqual({
      media: { type: 'video', url: 'https://ig/reel.mp4', poster: 'https://ig/poster.jpg' },
      thumbnail: 'https://ig/poster.jpg',
    })
  })

  it('falls back to an image when type is Video but videoUrl is missing', () => {
    const raw = { type: 'Video', videoUrl: null, displayUrl: 'https://ig/poster.jpg' } as unknown as ApifyInstagramPost
    expect(extractInstagramMedia(raw)).toEqual({
      media: { type: 'image', images: ['https://ig/poster.jpg'] },
      thumbnail: 'https://ig/poster.jpg',
    })
  })

  it('returns { null, null } when there is no media at all', () => {
    expect(extractInstagramMedia({} as ApifyInstagramPost)).toEqual({ media: null, thumbnail: null })
  })
})

describe('isPostMedia', () => {
  it('accepts each valid variant (incl. null optional fields)', () => {
    expect(isPostMedia({ type: 'image', images: ['a', 'b'] })).toBe(true)
    expect(isPostMedia({ type: 'video', url: 'v', poster: 'p' })).toBe(true)
    expect(isPostMedia({ type: 'video', url: 'v', poster: null })).toBe(true)
    expect(isPostMedia({ type: 'document', url: 'd', title: 't', pages: 3, cover: 'c' })).toBe(true)
    expect(isPostMedia({ type: 'document', url: 'd', title: null, pages: null, cover: null })).toBe(true)
  })

  it('rejects non-objects and unknown/missing types', () => {
    expect(isPostMedia(null)).toBe(false)
    expect(isPostMedia('nope')).toBe(false)
    expect(isPostMedia({ type: 'bogus' })).toBe(false)
    expect(isPostMedia({})).toBe(false)
  })

  it('rejects a wrong shape within a known type', () => {
    expect(isPostMedia({ type: 'image', images: [1, 2] })).toBe(false) // non-string element
    expect(isPostMedia({ type: 'image', images: 'x' })).toBe(false) // not an array
    expect(isPostMedia({ type: 'video', url: 42, poster: null })).toBe(false) // url not string
    expect(isPostMedia({ type: 'video', url: 'v', poster: 7 })).toBe(false) // poster wrong type
    expect(isPostMedia({ type: 'document', url: 5, title: null, pages: null, cover: null })).toBe(false)
    expect(isPostMedia({ type: 'document', url: 'd', title: 9, pages: null, cover: null })).toBe(false)
    expect(isPostMedia({ type: 'document', url: 'd', title: null, pages: 'x', cover: null })).toBe(false)
    expect(isPostMedia({ type: 'document', url: 'd', title: null, pages: null, cover: 3 })).toBe(false)
  })
})
