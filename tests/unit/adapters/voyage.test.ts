import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import { embedImage, embedTexts } from '@/lib/voyage'
import { MAX_IMAGE_BYTES, VOYAGE_MULTIMODAL_URL, VOYAGE_TEXT_URL } from '@/lib/config'
import { server } from '@/tests/msw/server'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('embedTexts', () => {
  it('throws a clear error when the Voyage key is unset', async () => {
    await expect(embedTexts(['hello'])).rejects.toThrow(/voyage/i)
  })

  it('returns one vector per input, preserving order', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(
      http.post(VOYAGE_TEXT_URL, async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          data: body.input.map((s, i) => ({ embedding: [Number(s.slice(1))], index: i })),
        })
      }),
    )
    const out = await embedTexts(['t0', 't1', 't2'])
    expect(out).toEqual([[0], [1], [2]])
  })

  it('batches inputs at 100 per request and concatenates in global order', async () => {
    setSettings({ voyage_api_key: 'vk' })
    let requests = 0
    server.use(
      http.post(VOYAGE_TEXT_URL, async ({ request }) => {
        requests++
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          data: body.input.map((s, i) => ({ embedding: [Number(s.slice(1))], index: i })),
        })
      }),
    )
    const inputs = Array.from({ length: 150 }, (_, i) => `t${i}`)
    const out = await embedTexts(inputs)
    expect(requests).toBe(2) // 100 + 50
    expect(out).toHaveLength(150)
    expect(out.map((v) => v[0])).toEqual(inputs.map((_, i) => i))
  })

  it('reorders by the response index field', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(
      http.post(VOYAGE_TEXT_URL, () =>
        // returned out of order — the adapter must sort by index
        HttpResponse.json({
          data: [
            { embedding: [2], index: 2 },
            { embedding: [0], index: 0 },
            { embedding: [1], index: 1 },
          ],
        }),
      ),
    )
    expect(await embedTexts(['a', 'b', 'c'])).toEqual([[0], [1], [2]])
  })

  it('throws when a batch request fails', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(http.post(VOYAGE_TEXT_URL, () => new HttpResponse(null, { status: 500 })))
    await expect(embedTexts(['x'])).rejects.toThrow(/voyage/i)
  })

  it('throws on a malformed 2xx response (data not an array)', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(http.post(VOYAGE_TEXT_URL, () => HttpResponse.json({ notdata: true })))
    await expect(embedTexts(['x'])).rejects.toThrow(/voyage/i)
  })

  it('throws when a returned item is missing its embedding array', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(http.post(VOYAGE_TEXT_URL, () => HttpResponse.json({ data: [{ index: 0 }] })))
    await expect(embedTexts(['x'])).rejects.toThrow(/voyage/i)
  })

  it('aborts a hung embed batch via its per-fetch timeout instead of blocking forever', async () => {
    vi.useFakeTimers()
    try {
      setSettings({ voyage_api_key: 'vk' })
      server.use(http.post(VOYAGE_TEXT_URL, () => new Promise<Response>(() => {}))) // never resolves
      const expectation = expect(embedTexts(['x'])).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(61_000) // past EMBED_TIMEOUT_MS (60 s)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })
})

// embedImage DOWNLOADS the image and posts it as base64 rather than handing Voyage the url (§7.3).
// Voyage's server-side fetcher is blocked by LinkedIn's CDN — it answers 400 "image URL is invalid"
// for urls that are signed, unexpired, and serve a 200 to us — so passing a url embedded NOTHING
// from LinkedIn, which is the bulk of the corpus.
const imageBytes = (body: Uint8Array, contentType = 'image/jpeg'): Response =>
  new HttpResponse(body, { headers: { 'content-type': contentType } })

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

describe('embedImage', () => {
  it('downloads the image and sends it to Voyage as inline base64, not as a url', async () => {
    setSettings({ voyage_api_key: 'vk' })
    let sent: { type: string; image_base64?: string; image_url?: string } | undefined
    server.use(
      http.get('https://img/1.png', () => imageBytes(PNG, 'image/png')),
      http.post(VOYAGE_MULTIMODAL_URL, async ({ request }) => {
        const body = (await request.json()) as {
          inputs: { content: { type: string; image_base64?: string; image_url?: string }[] }[]
        }
        sent = body.inputs[0]!.content[0]
        return HttpResponse.json({ data: [{ embedding: [1, 2, 3, 4] }] })
      }),
    )
    expect(await embedImage('https://img/1.png')).toEqual([1, 2, 3, 4])
    expect(sent?.type).toBe('image_base64')
    expect(sent?.image_url).toBeUndefined()
    expect(sent?.image_base64).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  it('throws when the key is unset, before fetching anything', async () => {
    await expect(embedImage('https://img/1.png')).rejects.toThrow(/voyage/i)
  })

  it('throws on a malformed 2xx response (empty data / missing embedding)', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(
      http.get('https://img/1.png', () => imageBytes(PNG, 'image/png')),
      http.post(VOYAGE_MULTIMODAL_URL, () => HttpResponse.json({ data: [] })),
    )
    await expect(embedImage('https://img/1.png')).rejects.toThrow(/voyage/i)
  })

  it('reports an unreachable image (expired signed url) distinctly from a Voyage failure', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(http.get('https://img/gone.png', () => new HttpResponse(null, { status: 403 })))
    await expect(embedImage('https://img/gone.png')).rejects.toThrow(/image fetch failed \(403\)/i)
  })

  it('refuses a response that is not an image, rather than base64-ing an error page', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(
      http.get('https://img/notimg', () =>
        HttpResponse.text('<html>nope</html>', { headers: { 'content-type': 'text/html' } }),
      ),
    )
    await expect(embedImage('https://img/notimg')).rejects.toThrow(/not an image/i)
  })

  it('refuses an oversized image instead of building a huge request body', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(
      http.get('https://img/huge.png', () => imageBytes(new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png')),
    )
    await expect(embedImage('https://img/huge.png')).rejects.toThrow(/too large/i)
  })

  it('refuses a non-http(s) url — this fetch runs server-side, so the scheme is not decoration', async () => {
    setSettings({ voyage_api_key: 'vk' })
    await expect(embedImage('file:///etc/passwd')).rejects.toThrow(/http/i)
  })
})
