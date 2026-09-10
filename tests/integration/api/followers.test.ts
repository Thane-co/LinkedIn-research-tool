import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as leaderboard } from '@/app/api/followers/route'
import { GET as creatorDetail } from '@/app/api/followers/[authorId]/route'
import { POST as capture } from '@/app/api/followers/snapshot/route'
import { snapshotFollowers } from '@/jobs/snapshot-followers'
import { setCreatorTracking, upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { recordSnapshot } from '@/lib/db/followers.repo'
import { setSettings } from '@/lib/settings'

vi.mock('@/jobs/snapshot-followers', () => ({ snapshotFollowers: vi.fn() }))
const mockSnapshot = vi.mocked(snapshotFollowers)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
})
afterEach(() => resetDb())

// §21.8 — the board shows the tracked subset, so route fixtures opt in.
const creator = (author_id: string) => {
  const row = upsertCreator({
    platform: 'linkedin',
    profile_url: `https://www.linkedin.com/in/${author_id}`,
    author_id,
    display_name: author_id,
  })
  setCreatorTracking(row.id, true)
  return row
}

const cap = (author_id: string, day: string, followers: number) =>
  recordSnapshot({
    author_id,
    platform: 'linkedin',
    captured_on: day,
    captured_at: `${day}T06:00:00.000Z`,
    followers,
    connections: null,
    source: 'profile-actor',
  })

const get = (url: string): Request => new Request(`http://localhost${url}`)

describe('GET /api/followers (leaderboard)', () => {
  beforeEach(() => {
    creator('jane')
    cap('jane', '2026-09-08', 20_000)
    cap('jane', '2026-09-09', 20_500)
  })

  it('returns both boards with the window echoed back', async () => {
    const res = await leaderboard(get('/api/followers?window=1&asOf=2026-09-09'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.window_days).toBe(1)
    expect(body.as_of).toBe('2026-09-09')
    expect(body.absolute[0]).toMatchObject({ author_id: 'jane', gained: 500, rank: 1 })
    expect(body.percent[0]).toMatchObject({ author_id: 'jane' })
  })

  it('defaults to a 1-day window', async () => {
    const body = await (await leaderboard(get('/api/followers?asOf=2026-09-09'))).json()
    expect(body.window_days).toBe(1)
  })

  it('accepts only the supported windows and rejects anything else with 400', async () => {
    for (const w of [1, 7, 30]) {
      expect((await leaderboard(get(`/api/followers?window=${w}`))).status).toBe(200)
    }
    const bad = await leaderboard(get('/api/followers?window=365'))
    expect(bad.status).toBe(400)
  })

  it('rejects a malformed asOf rather than silently falling back to today', async () => {
    expect((await leaderboard(get('/api/followers?asOf=yesterday'))).status).toBe(400)
  })
})

describe('GET /api/followers/[authorId]', () => {
  it('returns one creator series with its per-day deltas', async () => {
    creator('jane')
    cap('jane', '2026-09-08', 20_000)
    cap('jane', '2026-09-09', 20_500)

    const res = await creatorDetail(get('/api/followers/jane?asOf=2026-09-09'), { params: { authorId: 'jane' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.author_id).toBe('jane')
    expect(body.days[0]).toMatchObject({ gained: 500 })
  })

  it('returns an empty series (200) for an unknown creator, not a 404', async () => {
    const res = await creatorDetail(get('/api/followers/nobody'), { params: { authorId: 'nobody' } })
    expect(res.status).toBe(200)
    expect((await res.json()).series).toEqual([])
  })
})

describe('POST /api/followers/snapshot', () => {
  const post = (origin?: string): Request =>
    new Request('http://localhost/api/followers/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    })

  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    expect((await capture(post('https://evil.example.com'))).status).toBe(403)
  })

  it('412s with the missing key when the Apify token is absent', async () => {
    const res = await capture(post())
    expect(res.status).toBe(412)
    expect((await res.json()).needs).toEqual(['apify_api_token'])
  })

  it('runs the capture and returns its report', async () => {
    setSettings({ apify_api_token: 'tok' })
    mockSnapshot.mockResolvedValue({
      captured_on: '2026-09-09',
      requested: 67,
      captured: 66,
      skipped: [],
      missing: ['ghost'],
      errors: [],
    })

    const res = await capture(post())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ captured: 66, missing: ['ghost'] })
  })

  it('502s when the capture throws', async () => {
    setSettings({ apify_api_token: 'tok' })
    mockSnapshot.mockRejectedValue(new Error('no actor configured'))

    const res = await capture(post())
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('no actor configured')
  })
})
