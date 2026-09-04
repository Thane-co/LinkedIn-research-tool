import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/media/route'
import { server } from '@/tests/msw/server'

afterEach(() => server.resetHandlers())

const req = (url: string): Request => new Request(`http://localhost/api/media?url=${encodeURIComponent(url)}`)

describe('GET /api/media (Instagram/FB/LinkedIn CDN image proxy, §18)', () => {
  it('400s a url whose host is not an allowed media CDN (SSRF guard)', async () => {
    const res = await GET(req('https://evil.com/secret.jpg'))
    expect(res.status).toBe(400)
  })

  it('400s when the url param is missing', async () => {
    const res = await GET(new Request('http://localhost/api/media'))
    expect(res.status).toBe(400)
  })

  it('streams the upstream image back with its content-type when the host is allowed', async () => {
    server.use(
      http.get('https://scontent-lga3-1.cdninstagram.com/v/poster.jpg', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3, 4]).buffer, {
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    )
    const res = await GET(req('https://scontent-lga3-1.cdninstagram.com/v/poster.jpg'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toMatch(/max-age/)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('proxies a LinkedIn CDN poster with a linkedin.com referer', async () => {
    let seenReferer: string | null = null
    server.use(
      http.get('https://media.licdn.com/dms/image/poster.jpg', ({ request }) => {
        seenReferer = request.headers.get('referer')
        return HttpResponse.arrayBuffer(new Uint8Array([9, 9]).buffer, {
          headers: { 'content-type': 'image/jpeg' },
        })
      }),
    )
    const res = await GET(req('https://media.licdn.com/dms/image/poster.jpg'))
    expect(res.status).toBe(200)
    expect(seenReferer).toBe('https://www.linkedin.com/')
  })

  it('502s when the upstream fetch fails', async () => {
    server.use(
      http.get('https://scontent-lga3-1.cdninstagram.com/v/gone.jpg', () => new HttpResponse(null, { status: 404 })),
    )
    const res = await GET(req('https://scontent-lga3-1.cdninstagram.com/v/gone.jpg'))
    expect(res.status).toBe(502)
  })
})
