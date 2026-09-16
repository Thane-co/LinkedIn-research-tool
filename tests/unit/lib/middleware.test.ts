import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

afterEach(() => {
  delete process.env.READONLY_SERVER
})

const call = (method: string, path = '/api/scrape'): Response =>
  middleware(new NextRequest(`http://localhost${path}`, { method }))

describe('read-only server mode (§20.4)', () => {
  it('is inert unless READONLY_SERVER=1 — the normal instance still mutates', () => {
    expect(call('POST').status).toBe(200) // NextResponse.next()
    process.env.READONLY_SERVER = '0'
    expect(call('POST').status).toBe(200)
  })

  it('refuses every write method when enabled, whatever the path', async () => {
    process.env.READONLY_SERVER = '1'
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/scrape', '/api/transcribe', '/api/settings', '/api/creators/backfill-personas', '/api/creators']) {
        const res = call(method, path)
        expect(res.status, `${method} ${path}`).toBe(403)
      }
    }
    expect((await call('POST').json()).error).toMatch(/read-only/i)
  })

  it('serves GETs on /api/v1 only, so the token is the single door', () => {
    process.env.READONLY_SERVER = '1'
    expect(call('GET', '/api/v1').status).toBe(200)
    expect(call('GET', '/api/v1/posts').status).toBe(200)
    expect(call('HEAD', '/api/v1/stats').status).toBe(200)
  })

  it('refuses the app’s own unauthenticated GET routes, so revoking the token revokes access', () => {
    process.env.READONLY_SERVER = '1'
    // Each of these would otherwise serve the same data with no credential at all.
    for (const path of ['/api/posts', '/api/creators', '/api/keywords', '/api/settings', '/api/profile', '/api/scrape/history', '/']) {
      expect(call('GET', path).status, `GET ${path}`).toBe(403)
    }
  })

  it('fails closed on a path that only looks like the read-only api', () => {
    process.env.READONLY_SERVER = '1'
    expect(call('GET', '/api/v1x/posts').status).toBe(403)
    expect(call('GET', '//api/posts').status).toBe(403)
  })
})
