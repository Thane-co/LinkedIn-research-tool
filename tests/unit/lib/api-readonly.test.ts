import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireReadToken } from '@/lib/api-readonly'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const req = (headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/api/v1/posts', { headers })

describe('requireReadToken', () => {
  it('503s when no read-only token has been configured (fail closed, not open)', async () => {
    const res = requireReadToken(req({ authorization: 'Bearer anything' }))
    expect(res?.status).toBe(503)
    expect((await res!.json()).error).toMatch(/api:token/)
  })

  it('401s when the token is missing, wrong, or a wrong-length near-miss', async () => {
    setSettings({ readonly_api_token: 'secret-token' })
    expect(requireReadToken(req())?.status).toBe(401)
    expect(requireReadToken(req({ authorization: 'Bearer nope-nope-xx' }))?.status).toBe(401)
    // different length must not throw inside timingSafeEqual — it must be a plain 401
    expect(requireReadToken(req({ authorization: 'Bearer short' }))?.status).toBe(401)
    expect(requireReadToken(req({ 'x-api-key': 'wrong' }))?.status).toBe(401)
  })

  it('ignores a non-Bearer Authorization scheme', () => {
    setSettings({ readonly_api_token: 'secret-token' })
    expect(requireReadToken(req({ authorization: 'Basic secret-token' }))?.status).toBe(401)
  })

  it('passes a correct token via Authorization: Bearer or x-api-key', () => {
    setSettings({ readonly_api_token: 'secret-token' })
    expect(requireReadToken(req({ authorization: 'Bearer secret-token' }))).toBeNull()
    expect(requireReadToken(req({ authorization: '  bearer   secret-token  ' }))).toBeNull()
    expect(requireReadToken(req({ 'x-api-key': 'secret-token' }))).toBeNull()
  })

  it('never accepts a token passed in the query string (it would leak into logs/history)', () => {
    setSettings({ readonly_api_token: 'secret-token' })
    const res = requireReadToken(new Request('http://localhost/api/v1/posts?token=secret-token'))
    expect(res?.status).toBe(401)
  })
})
