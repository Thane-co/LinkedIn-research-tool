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
  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    const req = new Request('http://localhost/api/creators', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: ['@x'] }),
    })
    expect((await POST(req)).status).toBe(403)
  })

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

  it('adds a Substack creator from a publication url, deriving the handle + persona (§17)', async () => {
    insertPosts([makePostRow({ id: 'ps', author_id: 'laraacosta', author_name: 'Lara Acosta', platform: 'substack' })])
    const { creators } = await (
      await POST(postJson({ input: 'https://laraacosta.substack.com/p/the-breakdown' }))
    ).json()
    const lara = creators.find((c: { author_id: string }) => c.author_id === 'laraacosta')
    expect(lara.platform).toBe('substack')
    expect(lara.profile_url).toBe('https://laraacosta.substack.com') // canonicalized to the publication root
    expect(lara.persona).toBe('lara acosta') // auto-matched from the display name
  })

  it('adds an Instagram creator from a profile url, deriving the handle (§18)', async () => {
    const { creators } = await (
      await POST(postJson({ input: 'https://www.instagram.com/natgeo/' }))
    ).json()
    const nat = creators.find((c: { author_id: string }) => c.author_id === 'natgeo')
    expect(nat.platform).toBe('instagram')
    expect(nat.profile_url).toBe('https://www.instagram.com/natgeo/')
  })

  it('links a person across platforms: auto-match by name, with an explicit persona override', async () => {
    insertPosts([makePostRow({ id: 'p1', author_id: 'lara-li', author_name: 'Lara Acosta', platform: 'linkedin' })])
    await POST(postJson({ input: 'https://www.linkedin.com/in/lara-li' })) // persona auto-derived
    // the Substack account has no post yet (no display name) → pass an explicit persona to link it
    const { creators } = await (
      await POST(postJson({ input: 'https://laraacosta.substack.com', persona: 'lara acosta' }))
    ).json()
    const personas = creators
      .filter((c: { author_id: string }) => ['lara-li', 'laraacosta'].includes(c.author_id))
      .map((c: { persona: string | null }) => c.persona)
    expect(personas).toEqual(['lara acosta', 'lara acosta']) // both accounts = one person
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
