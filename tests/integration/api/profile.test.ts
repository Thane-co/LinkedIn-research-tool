import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from '@/app/api/profile/route'
import { scrapeProfile } from '@/jobs/scrape-profile'
import { getDb, resetDb } from '@/lib/db/db'
import { upsertProfile } from '@/lib/db/profiles.repo'
import { setSettings } from '@/lib/settings'
import type { ProfileRow } from '@/lib/types'

// The route awaits scrapeProfile; mock it so no real actor runs.
vi.mock('@/jobs/scrape-profile', () => ({ scrapeProfile: vi.fn() }))
const mockScrapeProfile = vi.mocked(scrapeProfile)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
})
afterEach(() => resetDb())

const postProfile = (body: unknown, origin?: string): Request =>
  new Request('http://localhost/api/profile', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  })

const row = (over: Partial<ProfileRow> = {}): ProfileRow => ({
  id: 'basiakubicka',
  url: 'https://www.linkedin.com/in/basiakubicka/',
  name: 'Basia Kubicka',
  headline: 'AI PM',
  about: null,
  followers: 69000,
  connections: 500,
  location: null,
  avatar_url: null,
  experience: null,
  education: null,
  skills: null,
  scraped_at: '2026-07-20T10:00:00.000Z',
  raw_data: null,
  ...over,
})

describe('POST /api/profile', () => {
  it('refuses a cross-origin request with 403 (CSRF guard)', async () => {
    const res = await POST(postProfile({ query: 'basiakubicka' }, 'https://evil.example.com'))
    expect(res.status).toBe(403)
  })

  it('412s with the missing key when the Apify token is absent', async () => {
    const res = await POST(postProfile({ query: 'basiakubicka' }))
    expect(res.status).toBe(412)
    expect((await res.json()).needs).toEqual(['apify_api_token'])
  })

  it('400s when no query is provided', async () => {
    setSettings({ apify_api_token: 'tok' })
    expect((await POST(postProfile({}))).status).toBe(400)
    expect((await POST(postProfile({ query: '   ' }))).status).toBe(400) // whitespace-only
  })

  it('scrapes and returns the profile on success', async () => {
    setSettings({ apify_api_token: 'tok' })
    mockScrapeProfile.mockResolvedValue(row())
    const res = await POST(postProfile({ query: 'https://www.linkedin.com/in/basiakubicka/' }))
    expect(res.status).toBe(200)
    const { profile } = await res.json()
    expect(profile.followers).toBe(69000)
    expect(mockScrapeProfile).toHaveBeenCalledWith('https://www.linkedin.com/in/basiakubicka/')
  })

  it('502s when the scrape fails (actor error / no profile)', async () => {
    setSettings({ apify_api_token: 'tok' })
    mockScrapeProfile.mockRejectedValue(new Error('actor returned no profile'))
    const res = await POST(postProfile({ query: 'ghost' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/no profile/i)
  })
})

describe('GET /api/profile', () => {
  it('lists the stored profiles (newest first)', async () => {
    upsertProfile(row({ id: 'older', url: 'https://li/in/older', scraped_at: '2026-07-19T10:00:00.000Z' }))
    upsertProfile(row({ id: 'newer', url: 'https://li/in/newer', scraped_at: '2026-07-20T10:00:00.000Z' }))
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).profiles.map((p: ProfileRow) => p.id)).toEqual(['newer', 'older'])
  })
})
