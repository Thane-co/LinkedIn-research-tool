// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELETE, GET, POST } from '@/app/api/saved-searches/route'
import { getDb, resetDb } from '@/lib/db/db'
import { createSavedSearch } from '@/lib/db/saved-searches.repo'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const post = (body: unknown): Request =>
  new Request('http://localhost/api/saved-searches', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('/api/saved-searches', () => {
  it('POST creates a preset and GET lists it (params round-trip)', async () => {
    const res = await POST(post({ name: 'Viral AI', params: { platform: 'linkedin', minLikes: 500 } }))
    expect(res.status).toBe(200)
    const { searches } = await (await GET(new Request('http://localhost/api/saved-searches'))).json()
    expect(searches).toHaveLength(1)
    expect(searches[0].name).toBe('Viral AI')
    expect(JSON.parse(searches[0].params)).toEqual({ platform: 'linkedin', minLikes: 500 })
  })

  it('POST 400s without a name', async () => {
    expect((await POST(post({ params: {} }))).status).toBe(400)
  })

  it('DELETE removes a preset by id', async () => {
    const row = createSavedSearch('A', { sort: 'likes' })
    const res = await DELETE(new Request(`http://localhost/api/saved-searches?id=${row.id}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const { searches } = await res.json()
    expect(searches).toHaveLength(0)
  })

  it('DELETE 400s without id', async () => {
    expect((await DELETE(new Request('http://localhost/api/saved-searches', { method: 'DELETE' }))).status).toBe(400)
  })
})
