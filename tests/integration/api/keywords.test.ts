// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELETE, GET, POST } from '@/app/api/keywords/route'
import { getDb, resetDb } from '@/lib/db/db'
import { addKeyword } from '@/lib/db/keywords.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const post = (body: unknown): Request =>
  new Request('http://localhost/api/keywords', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('/api/keywords', () => {
  it('refuses a cross-origin POST with 403 (CSRF guard)', async () => {
    const req = new Request('http://localhost/api/keywords', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ market: 'ai', term: 'agents' }),
    })
    expect((await POST(req)).status).toBe(403)
  })

  it('GET returns keywords grouped by market', async () => {
    addKeyword('ai', 'llm')
    addKeyword('linkedin', 'claude code')
    const { groups } = await (await GET(new Request('http://localhost/api/keywords'))).json()
    expect(groups.map((g: { market: string }) => g.market).sort()).toEqual(['ai', 'linkedin'])
  })

  it('POST adds a keyword and returns the refreshed groups', async () => {
    const res = await POST(post({ market: 'ai', term: 'agents' }))
    expect(res.status).toBe(200)
    const { groups } = await res.json()
    expect(groups.find((g: { market: string }) => g.market === 'ai').terms[0].term).toBe('agents')
  })

  it('POST 400s without market/term', async () => {
    expect((await POST(post({ market: 'ai' }))).status).toBe(400)
  })

  it('DELETE removes a single keyword by id', async () => {
    const row = addKeyword('ai', 'llm')
    const res = await DELETE(new Request(`http://localhost/api/keywords?id=${row.id}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const { groups } = await res.json()
    expect(groups).toHaveLength(0)
  })

  it('DELETE removes a whole market with ?market=', async () => {
    addKeyword('ai', 'llm')
    addKeyword('ai', 'agents')
    const res = await DELETE(new Request('http://localhost/api/keywords?market=ai', { method: 'DELETE' }))
    const { groups } = await res.json()
    expect(groups).toHaveLength(0)
  })

  it('DELETE 400s without id or market', async () => {
    expect((await DELETE(new Request('http://localhost/api/keywords', { method: 'DELETE' }))).status).toBe(400)
  })
})
