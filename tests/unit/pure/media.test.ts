import { describe, expect, it } from 'vitest'
import { extractMedia } from '@/lib/pure/media'
import type { ApifyPost } from '@/lib/types'

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
