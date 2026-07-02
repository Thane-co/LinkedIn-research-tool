import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, apiFetch } from '@/lib/api-client'
import { server } from '@/tests/msw/server'

const URL = 'http://localhost/api/thing'

afterEach(() => server.resetHandlers())

describe('apiFetch', () => {
  it('returns the parsed JSON body on a 2xx response', async () => {
    server.use(http.get(URL, () => HttpResponse.json({ ok: true, n: 3 })))
    expect(await apiFetch<{ ok: boolean; n: number }>(URL)).toEqual({ ok: true, n: 3 })
  })

  it('throws an ApiError carrying the status + server error message on a non-2xx response', async () => {
    server.use(http.get(URL, () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    await expect(apiFetch(URL)).rejects.toMatchObject({ name: 'ApiError', status: 500, message: 'boom' })
    await expect(apiFetch(URL)).rejects.toBeInstanceOf(ApiError)
  })

  it('falls back to a generic message when the error body has no error field', async () => {
    server.use(http.get(URL, () => new HttpResponse('nope', { status: 503 })))
    await expect(apiFetch(URL)).rejects.toMatchObject({ status: 503, message: /503/ })
  })

  it('exposes the parsed error body so callers can branch (e.g. a 412 needs list)', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ needs: ['voyage_api_key'] }, { status: 412 })))
    try {
      await apiFetch(URL, { method: 'POST' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      const e = err as ApiError
      expect(e.status).toBe(412)
      expect((e.body as { needs: string[] }).needs).toEqual(['voyage_api_key'])
    }
  })

  it('throws an ApiError with status 0 on a network failure', async () => {
    server.use(http.get(URL, () => HttpResponse.error()))
    await expect(apiFetch(URL)).rejects.toMatchObject({ name: 'ApiError', status: 0 })
  })

  it('throws when a 2xx body is not valid JSON', async () => {
    server.use(
      http.get(URL, () => new HttpResponse('<html>not json</html>', { status: 200, headers: { 'content-type': 'application/json' } })),
    )
    await expect(apiFetch(URL)).rejects.toMatchObject({ name: 'ApiError', message: /malformed/i })
  })
})
