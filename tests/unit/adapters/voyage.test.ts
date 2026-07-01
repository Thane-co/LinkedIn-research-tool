import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import { embedImage, embedTexts } from '@/lib/voyage'
import { VOYAGE_MULTIMODAL_URL, VOYAGE_TEXT_URL } from '@/lib/config'
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

describe('embedImage', () => {
  it('returns a single embedding for an image url', async () => {
    setSettings({ voyage_api_key: 'vk' })
    server.use(
      http.post(VOYAGE_MULTIMODAL_URL, () =>
        HttpResponse.json({ data: [{ embedding: [1, 2, 3, 4] }] }),
      ),
    )
    expect(await embedImage('https://img/1.png')).toEqual([1, 2, 3, 4])
  })

  it('throws when the key is unset', async () => {
    await expect(embedImage('https://img/1.png')).rejects.toThrow(/voyage/i)
  })
})
