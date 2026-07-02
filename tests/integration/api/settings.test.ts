import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET, PUT } from '@/app/api/settings/route'
import { POST as TEST_POST } from '@/app/api/settings/test/route'
import { getDb, resetDb } from '@/lib/db/db'
import { getKey } from '@/lib/settings'
import { server } from '@/tests/msw/server'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const jsonReq = (method: string, body?: unknown): Request =>
  new Request('http://localhost/api/settings', {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })

describe('GET /api/settings', () => {
  it('masks secret values and reports readiness (all false before any key set)', async () => {
    const res = await GET(new Request('http://localhost/api/settings'))
    expect(res.status).toBe(200)
    const body = await res.json()
    // secrets masked, never raw
    expect(body.settings.apify_api_token).toBe('unset')
    expect(body.settings.voyage_api_key).toBe('unset')
    expect(body.settings.anthropic_api_key).toBe('unset')
    // non-secret actor-id defaults are visible
    expect(body.settings.apify_keyword_actor_id).toBe('harvestapi/linkedin-post-search')
    expect(body.ready).toEqual({ apify: false, voyage: false, anthropic: false })
  })

  it('reports set/ready once secrets are stored, still never leaking the raw value', async () => {
    await PUT(jsonReq('PUT', { apify_api_token: 'SEKRET-raw-value', voyage_api_key: 'vk' }))
    const body = await (await GET(new Request('http://localhost/api/settings'))).json()
    expect(body.settings.apify_api_token).toBe('set')
    expect(body.settings.voyage_api_key).toBe('set')
    expect(body.settings.anthropic_api_key).toBe('unset')
    expect(JSON.stringify(body)).not.toContain('SEKRET') // raw never serialized
    expect(body.ready).toEqual({ apify: true, voyage: true, anthropic: false })
  })
})

describe('PUT /api/settings', () => {
  it('refuses a cross-origin PUT with 403 (CSRF guard — keys can be overwritten here)', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ apify_api_token: 'stolen' }),
    })
    expect((await PUT(req)).status).toBe(403)
  })

  it('trims values and writes only the provided keys', async () => {
    const res = await PUT(jsonReq('PUT', { apify_api_token: '  spacey  ' }))
    expect(res.status).toBe(200)
    expect(getKey('apify_api_token')).toBe('spacey') // trimmed
    // untouched non-secret default remains
    expect(getKey('apify_keyword_actor_id')).toBe('harvestapi/linkedin-post-search')
  })

  it('treats an empty string as clearing the key', async () => {
    await PUT(jsonReq('PUT', { voyage_api_key: 'vk' }))
    expect(getKey('voyage_api_key')).toBe('vk')
    await PUT(jsonReq('PUT', { voyage_api_key: '   ' })) // trims to empty -> cleared
    expect(getKey('voyage_api_key')).toBeUndefined()
  })
})

describe('POST /api/settings/test', () => {
  it('returns per-provider ok/error, live-probing only the providers that have keys', async () => {
    await PUT(jsonReq('PUT', { apify_api_token: 'tok', voyage_api_key: 'vk' })) // anthropic left unset
    server.use(
      http.get('https://api.apify.com/v2/users/me', () => HttpResponse.json({ data: { id: 'u' } })),
      http.post('https://api.voyageai.com/v1/embeddings', () =>
        HttpResponse.json({ data: [{ embedding: [1], index: 0 }] }),
      ),
    )
    const res = await TEST_POST(new Request('http://localhost/api/settings/test', { method: 'POST' }))
    const body = await res.json()
    expect(body.apify.ok).toBe(true)
    expect(body.voyage.ok).toBe(true)
    expect(body.anthropic.ok).toBe(false) // no key -> not ok
  })

  it('marks a provider not-ok when the live probe fails', async () => {
    await PUT(jsonReq('PUT', { apify_api_token: 'bad' }))
    server.use(
      http.get('https://api.apify.com/v2/users/me', () => new HttpResponse(null, { status: 401 })),
    )
    const res = await TEST_POST(new Request('http://localhost/api/settings/test', { method: 'POST' }))
    const body = await res.json()
    expect(body.apify.ok).toBe(false)
    expect(body.apify.error).toBeTruthy()
  })
})
