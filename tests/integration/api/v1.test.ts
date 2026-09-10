// Integration — the read-only agent API (PRD §20). Every route: token-gated, GET-only, no writes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET as manifest } from '@/app/api/v1/route'
import { GET as authors } from '@/app/api/v1/authors/route'
import { GET as creators } from '@/app/api/v1/creators/route'
import { GET as keywords } from '@/app/api/v1/keywords/route'
import { GET as openapi } from '@/app/api/v1/openapi.json/route'
import { GET as posts } from '@/app/api/v1/posts/route'
import { GET as postById } from '@/app/api/v1/posts/[id]/route'
import { GET as profiles } from '@/app/api/v1/profiles/route'
import { GET as stats } from '@/app/api/v1/stats/route'
import { getDb, resetDb } from '@/lib/db/db'
import { upsertCreator } from '@/lib/db/creators.repo'
import { addKeyword } from '@/lib/db/keywords.repo'
import { insertPosts } from '@/lib/db/posts.repo'
import { upsertProfile } from '@/lib/db/profiles.repo'
import { vectorToBlob } from '@/lib/pure/vector-blob'
import { setSettings } from '@/lib/settings'
import { makePostRow } from '@/tests/fixtures/posts'
import type { PostRow } from '@/lib/types'

const TOKEN = 'test-readonly-token'

beforeEach(() => {
  getDb(':memory:')
  setSettings({ readonly_api_token: TOKEN })
})
afterEach(() => resetDb())

const seed = (rows: Partial<PostRow>[]): void => {
  insertPosts(rows.map((r) => makePostRow(r)))
}

const authed = (path: string): Request =>
  new Request(`http://localhost/api/v1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
const anon = (path: string): Request => new Request(`http://localhost/api/v1${path}`)

describe('read-only API — auth', () => {
  it('401s every route without a token and 200s with one', async () => {
    const routes: [string, (req: Request) => Promise<Response>][] = [
      ['', manifest],
      ['/openapi.json', openapi],
      ['/posts', posts],
      ['/authors', authors],
      ['/creators', creators],
      ['/keywords', keywords],
      ['/profiles', profiles],
      ['/stats', stats],
    ]
    for (const [path, handler] of routes) {
      expect((await handler(anon(path))).status, `${path} anon`).toBe(401)
      expect((await handler(authed(path))).status, `${path} authed`).toBe(200)
    }
    expect((await postById(anon('/posts/x'), { params: { id: 'x' } })).status).toBe(401)
  })

  it('exposes only GET handlers — no mutating export exists on any v1 route', async () => {
    const modules = await Promise.all([
      import('@/app/api/v1/route'),
      import('@/app/api/v1/posts/route'),
      import('@/app/api/v1/posts/[id]/route'),
      import('@/app/api/v1/authors/route'),
      import('@/app/api/v1/creators/route'),
      import('@/app/api/v1/keywords/route'),
      import('@/app/api/v1/profiles/route'),
      import('@/app/api/v1/stats/route'),
      import('@/app/api/v1/openapi.json/route'),
    ])
    for (const mod of modules) {
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        expect(verb in mod, `${verb} must not be exported`).toBe(false)
      }
      expect('GET' in mod).toBe(true)
    }
  })
})

describe('GET /api/v1/posts', () => {
  it('applies the full filter set and strips blobs + raw_data', async () => {
    seed([
      { id: 'a', platform: 'linkedin', content: 'ai agents', likes: 100, embedding: vectorToBlob([1, 0, 0, 0]) },
      { id: 'b', platform: 'twitter', content: 'gardening', likes: 5 },
    ])
    const body = await (await posts(authed('/posts?platform=linkedin&minLikes=50&sort=likes'))).json()
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual(['a'])
    expect(body.posts[0].embedding).toBeUndefined()
    expect(body.posts[0].raw_data).toBeUndefined()
    expect(body.total).toBe(1)
    expect(body.availableAuthors.length).toBeGreaterThan(0)
  })

  it('accepts q as an alias for the keywords content filter', async () => {
    seed([
      { id: 'a', content: 'ai agents everywhere' },
      { id: 'b', content: 'gardening tips' },
    ])
    const body = await (await posts(authed('/posts?q=agents'))).json()
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual(['a'])
  })

  it('groups by image when groupByImage=true', async () => {
    const img = vectorToBlob([1, 0, 0, 0])
    seed([
      { id: 'a', embedding: img, image_embedding: img, image_url: 'https://x/1.jpg' },
      { id: 'b', embedding: img, image_embedding: img, image_url: 'https://x/2.jpg' },
    ])
    const body = await (await posts(authed('/posts?groupByImage=true'))).json()
    expect(body.imageGroups[0].postIds.sort()).toEqual(['a', 'b'])
    expect(body.hasMore).toBe(false)
  })

  it('clusters content when discoverTrends=true', async () => {
    const vec = vectorToBlob([1, 0, 0, 0])
    seed([
      { id: 'a', embedding: vec, content: 'ai agents' },
      { id: 'b', embedding: vec, content: 'ai agents again' },
    ])
    const body = await (await posts(authed('/posts?discoverTrends=true'))).json()
    expect(body.contentClusters[0].postIds.sort()).toEqual(['a', 'b'])
  })
})

describe('GET /api/v1/posts/[id]', () => {
  it('returns one post without blobs, and 404s an unknown id', async () => {
    seed([{ id: 'a', content: 'hello', embedding: vectorToBlob([1, 0, 0, 0]), raw_data: '{"secret":1}' }])
    const res = await postById(authed('/posts/a'), { params: { id: 'a' } })
    const body = await res.json()
    expect(body.post.id).toBe('a')
    expect(body.post.embedding).toBeUndefined()
    expect(body.post.raw_data).toBeUndefined()
    expect((await postById(authed('/posts/zz'), { params: { id: 'zz' } })).status).toBe(404)
  })
})

describe('GET /api/v1/authors, /creators, /keywords, /profiles', () => {
  it('lists authors honouring the post filters', async () => {
    seed([
      { id: 'a', author_id: 'jane', author_name: 'Jane', platform: 'linkedin' },
      { id: 'b', author_id: 'joe', author_name: 'Joe', platform: 'twitter' },
    ])
    const body = await (await authors(authed('/authors?platform=linkedin'))).json()
    expect(body.authors.map((a: { author_id: string }) => a.author_id)).toEqual(['jane'])
  })

  it('ignores an unrecognized creator platform rather than casting it into the query', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/in/jane', author_id: 'jane' })
    // Same typo that /api/v1/posts ignores — both endpoints must agree, not return opposite answers.
    const typo = await (await creators(authed('/creators?platform=LinkedIn'))).json()
    expect(typo.creators).toHaveLength(1)
  })

  it('lists creators and keyword sets', async () => {
    upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/in/jane', author_id: 'jane' })
    addKeyword('ai', 'ai agents')
    const c = await (await creators(authed('/creators'))).json()
    expect(c.creators[0].author_id).toBe('jane')
    const k = await (await keywords(authed('/keywords'))).json()
    expect(k.groups[0].terms[0].term).toBe('ai agents')
  })

  it('lists scraped profiles', async () => {
    upsertProfile({
      id: 'jane', url: 'https://www.linkedin.com/in/jane', name: 'Jane', headline: null, about: null,
      followers: 70000, connections: 500, location: null, avatar_url: null, experience: null,
      education: null, skills: null, scraped_at: '2026-06-01T00:00:00.000Z', raw_data: '{"x":1}',
    })
    const body = await (await profiles(authed('/profiles'))).json()
    expect(body.profiles[0].followers).toBe(70000)
    expect(body.profiles[0].raw_data).toBeUndefined() // raw payload never leaves the tool
  })
})

describe('GET /api/v1/stats', () => {
  it('summarizes the corpus so an agent can orient before querying', async () => {
    seed([
      { id: 'a', platform: 'linkedin', market: 'ai', likes: 10, embedding: vectorToBlob([1, 0, 0, 0]) },
      { id: 'b', platform: 'twitter', market: 'ai', likes: 5 },
    ])
    const body = await (await stats(authed('/stats'))).json()
    expect(body.totalPosts).toBe(2)
    expect(body.platforms.find((p: { platform: string }) => p.platform === 'linkedin').posts).toBe(1)
    expect(body.markets.map((m: { market: string }) => m.market)).toEqual(['ai'])
    expect(body.enrichment.embedded).toBe(1)
  })
})

describe('GET /api/v1 (manifest) and /openapi.json', () => {
  it('describes every endpoint and never leaks a secret setting', async () => {
    const body = await (await manifest(authed(''))).json()
    const paths = body.endpoints.map((e: { path: string }) => e.path)
    expect(paths).toContain('/api/v1/posts')
    expect(paths.every((p: string) => p.startsWith('/api/v1'))).toBe(true)
    expect(body.readOnly).toBe(true)
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    expect(JSON.stringify(body)).not.toMatch(/apify_api_token"\s*:\s*"[^"]/)
  })

  it('serves an OpenAPI document with GET-only operations', async () => {
    const spec = await (await openapi(authed('/openapi.json'))).json()
    expect(spec.openapi).toMatch(/^3\./)
    for (const [path, ops] of Object.entries(spec.paths as Record<string, object>)) {
      expect(Object.keys(ops), `${path} must be GET-only`).toEqual(['get'])
    }
  })
})
