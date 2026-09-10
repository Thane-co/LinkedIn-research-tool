import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET, PUT } from '@/app/api/creators/tracking/route'
import { listCreators, upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

const put = (body: unknown, origin?: string): Request =>
  new Request('http://localhost/api/creators/tracking', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  })

const creator = (author_id: string) =>
  upsertCreator({
    platform: 'linkedin',
    profile_url: `https://www.linkedin.com/in/${author_id}`,
    author_id,
    display_name: author_id,
  })

describe('GET /api/creators/tracking (the pick list)', () => {
  it('lists every LinkedIn creator with the data you would decide on', async () => {
    const jane = creator('jane')
    await PUT(put({ id: jane.id, tracked: true }))

    const body = await (await GET()).json()
    const row = body.creators.find((c: { author_id: string }) => c.author_id === 'jane')

    expect(row).toMatchObject({ author_id: 'jane', display_name: 'jane', tracked: true })
    expect(row).toHaveProperty('followers')
    expect(row).toHaveProperty('posts_30d')
  })

  it('reports how many are tracked and what that costs per month', async () => {
    const a = creator('a')
    creator('b')
    await PUT(put({ id: a.id, tracked: true }))

    const body = await (await GET()).json()
    expect(body.tracked_count).toBe(1)
    expect(body.total).toBe(2)
    expect(body.monthly_cost).toBeCloseTo(1 * 0.004 * 30, 5)
  })

  it('sorts by follower count so the biggest accounts are easy to find', async () => {
    creator('small')
    creator('big')
    const db = getDb()
    for (const [id, n] of [['small', 100], ['big', 90_000]] as const) {
      db.prepare(
        `INSERT INTO follower_snapshots (author_id, platform, captured_on, captured_at, followers, source)
         VALUES (?, 'linkedin', '2026-09-10', '2026-09-10T06:00:00.000Z', ?, 'profile-actor')`,
      ).run(id, n)
    }

    const body = await (await GET()).json()
    expect(body.creators.map((c: { author_id: string }) => c.author_id)).toEqual(['big', 'small'])
  })
})

describe('PUT /api/creators/tracking', () => {
  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    expect((await PUT(put({ id: 'x', tracked: true }, 'https://evil.example.com'))).status).toBe(403)
  })

  it('turns tracking on for one creator', async () => {
    const row = creator('jane')
    const res = await PUT(put({ id: row.id, tracked: true }))

    expect(res.status).toBe(200)
    expect((await res.json()).creator.track_followers).toBe(1)
  })

  it('turns tracking off again', async () => {
    const row = creator('jane')
    await PUT(put({ id: row.id, tracked: true }))
    const res = await PUT(put({ id: row.id, tracked: false }))
    expect((await res.json()).creator.track_followers).toBe(0)
  })

  it('sets many at once so a roster can be picked in one go', async () => {
    const a = creator('a')
    const b = creator('b')
    const c = creator('c')

    const res = await PUT(put({ ids: [a.id, b.id], tracked: true }))

    expect(res.status).toBe(200)
    expect((await res.json()).updated).toBe(2)
    expect(listCreators({ tracked: true }).creators.map((x) => x.author_id).sort()).toEqual(['a', 'b'])
    expect(listCreators({ tracked: false }).creators.map((x) => x.author_id)).toEqual([c.author_id])
  })

  it('404s an unknown creator rather than silently succeeding', async () => {
    expect((await PUT(put({ id: 'nope', tracked: true }))).status).toBe(404)
  })

  it('400s when tracked is missing or not a boolean', async () => {
    const row = creator('jane')
    expect((await PUT(put({ id: row.id }))).status).toBe(400)
    expect((await PUT(put({ id: row.id, tracked: 'yes' }))).status).toBe(400)
  })

  it('400s when neither id nor ids is given', async () => {
    expect((await PUT(put({ tracked: true }))).status).toBe(400)
  })
})
