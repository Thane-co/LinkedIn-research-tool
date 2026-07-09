import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchSubstackNoteContent } from '@/lib/substack'
import { server } from '@/tests/msw/server'

const API = 'https://substack.com/api/v1/reader/comment/:id'
const reader = (comment: unknown) => HttpResponse.json({ item: { comment } })

afterEach(() => server.resetHandlers())

describe('fetchSubstackNoteContent', () => {
  it('returns the note body when the note has text', async () => {
    server.use(http.get(API, () => reader({ body: 'a real note', attachments: [] })))
    expect(await fetchSubstackNoteContent('1')).toEqual({ content: 'a real note', imageUrl: null })
  })

  it('backfills a post-share note from the attached article (title+subtitle, cover, url)', async () => {
    server.use(
      http.get(API, () =>
        reader({
          body: '',
          attachments: [
            {
              type: 'post',
              post: {
                title: 'The 3x LinkedIn Post Templates',
                subtitle: 'Not gatekeeping here.',
                cover_image: 'https://cdn/cover.png',
              },
            },
          ],
        }),
      ),
    )
    expect(await fetchSubstackNoteContent('291136901')).toEqual({
      content: 'The 3x LinkedIn Post Templates\n\nNot gatekeeping here.',
      imageUrl: 'https://cdn/cover.png',
    })
  })

  it('returns null when the note is empty with no attachment', async () => {
    server.use(http.get(API, () => reader({ body: '', attachments: [] })))
    expect(await fetchSubstackNoteContent('1')).toBeNull()
  })

  it('returns null on a non-2xx response (non-fatal)', async () => {
    server.use(http.get(API, () => new HttpResponse(null, { status: 404 })))
    expect(await fetchSubstackNoteContent('1')).toBeNull()
  })

  it('returns null on a network error (non-fatal)', async () => {
    server.use(http.get(API, () => HttpResponse.error()))
    expect(await fetchSubstackNoteContent('1')).toBeNull()
  })
})
