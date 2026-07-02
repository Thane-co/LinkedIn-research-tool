import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELETE, GET, POST } from '@/app/api/creators/route'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts } from '@/lib/db/posts.repo'
import { makePostRow } from '@/tests/fixtures/posts'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const postJson = (body: unknown): Request =>
  new Request('http://localhost/api/creators', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('POST /api/creators', () => {
  it('adds a LinkedIn creator: detects platform, normalizes url, derives author_id', async () => {
    const res = await POST(postJson({ input: 'https://www.linkedin.com/in/jane-doe?miniProfileUrn=x' }))
    expect(res.status).toBe(200)
    const { creators } = await res.json()
    const jane = creators.find((c: { author_id: string }) => c.author_id === 'jane-doe')
    expect(jane.platform).toBe('linkedin')
    expect(jane.profile_url).toBe('https://www.linkedin.com/in/jane-doe') // query stripped
  })

  it('adds a Twitter creator from a bare @handle', async () => {
    const { creators } = await (await POST(postJson({ input: '@janedev' }))).json()
    const jane = creators.find((c: { author_id: string }) => c.author_id === 'janedev')
    expect(jane.platform).toBe('twitter')
    expect(jane.profile_url).toBe('https://x.com/janedev')
  })

  it('auto-fills display_name from an existing post by that author', async () => {
    insertPosts([makePostRow({ id: 'p1', author_id: 'jane-doe', author_name: 'Jane Doe' })])
    const { creators } = await (
      await POST(postJson({ input: 'https://www.linkedin.com/in/jane-doe' }))
    ).json()
    expect(creators.find((c: { author_id: string }) => c.author_id === 'jane-doe').display_name).toBe('Jane Doe')
  })

  it('adds many at once; re-adding an existing creator is idempotent (no duplicate)', async () => {
    await POST(postJson({ input: 'https://www.linkedin.com/in/jane-doe' }))
    const { creators } = await (
      await POST(postJson({ inputs: ['https://www.linkedin.com/in/jane-doe', '@joe'] }))
    ).json()
    expect(creators.filter((c: { author_id: string }) => c.author_id === 'jane-doe')).toHaveLength(1)
    expect(creators.some((c: { author_id: string }) => c.author_id === 'joe')).toBe(true)
  })

  it('rejects a body with no usable input', async () => {
    const res = await POST(postJson({ input: 'not a handle!' }))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/creators', () => {
  it('lists creators with distinct tags and filters by platform/tag', async () => {
    await POST(postJson({ input: 'https://www.linkedin.com/in/jane-doe', tags: ['ai'] }))
    await POST(postJson({ input: '@joe', tags: ['news'] }))

    const all = await (await GET(new Request('http://localhost/api/creators'))).json()
    expect(all.creators).toHaveLength(2)
    expect(all.tags.sort()).toEqual(['ai', 'news'])

    const li = await (await GET(new Request('http://localhost/api/creators?platform=linkedin'))).json()
    expect(li.creators.map((c: { author_id: string }) => c.author_id)).toEqual(['jane-doe'])

    const tagged = await (await GET(new Request('http://localhost/api/creators?tag=news'))).json()
    expect(tagged.creators.map((c: { author_id: string }) => c.author_id)).toEqual(['joe'])
  })
})

describe('DELETE /api/creators', () => {
  it('removes a creator by id', async () => {
    const { creators } = await (await POST(postJson({ input: '@joe' }))).json()
    const id = creators[0].id
    const res = await DELETE(new Request(`http://localhost/api/creators?id=${id}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const after = await (await GET(new Request('http://localhost/api/creators'))).json()
    expect(after.creators).toHaveLength(0)
  })

  it('400s when no id is supplied', async () => {
    const res = await DELETE(new Request('http://localhost/api/creators', { method: 'DELETE' }))
    expect(res.status).toBe(400)
  })
})
