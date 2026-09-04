import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrapeProfile } from '@/jobs/scrape-profile'
import { runActor } from '@/lib/apify'
import { getDb, resetDb } from '@/lib/db/db'
import { getProfile } from '@/lib/db/profiles.repo'
import { setSettings } from '@/lib/settings'
import type { ApifyProfile } from '@/lib/types'

// Keep the pure input builder real; mock only the network run.
vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
})
afterEach(() => resetDb())

const profileItem = (over: Partial<ApifyProfile> = {}): ApifyProfile => ({
  publicIdentifier: 'basiakubicka',
  linkedinUrl: 'https://www.linkedin.com/in/basiakubicka/',
  firstName: 'Basia',
  lastName: 'Kubicka',
  headline: 'AI PM',
  followerCount: 69000,
  connectionsCount: 500,
  ...over,
})

describe('scrapeProfile (§19)', () => {
  it('runs the configured profile-detail actor with a queries input and returns the mapped row', async () => {
    setSettings({ apify_profile_detail_actor_id: 'harvestapi/linkedin-profile-scraper' })
    mockRunActor.mockResolvedValue([profileItem()])

    const row = await scrapeProfile('https://www.linkedin.com/in/basiakubicka/')

    expect(row.id).toBe('basiakubicka')
    expect(row.followers).toBe(69000)
    // called the configured actor with the profile query
    expect(mockRunActor).toHaveBeenCalledTimes(1)
    const [actorId, input] = mockRunActor.mock.calls[0]!
    expect(actorId).toBe('harvestapi/linkedin-profile-scraper')
    expect((input as Record<string, unknown>).queries).toEqual(['https://www.linkedin.com/in/basiakubicka/'])
  })

  it('persists the profile (upsert) so it can be read back', async () => {
    setSettings({ apify_profile_detail_actor_id: 'harvestapi/linkedin-profile-scraper' })
    mockRunActor.mockResolvedValue([profileItem()])
    await scrapeProfile('basiakubicka')
    expect(getProfile('basiakubicka')!.headline).toBe('AI PM')
  })

  it('throws when the actor returns no profile', async () => {
    setSettings({ apify_profile_detail_actor_id: 'harvestapi/linkedin-profile-scraper' })
    mockRunActor.mockResolvedValue([])
    await expect(scrapeProfile('ghost')).rejects.toThrow(/no profile/i)
  })

  it('throws a clear error when no profile-detail actor is configured', async () => {
    setSettings({ apify_profile_detail_actor_id: '' }) // explicitly cleared
    await expect(scrapeProfile('basiakubicka')).rejects.toThrow(/actor/i)
    expect(mockRunActor).not.toHaveBeenCalled()
  })
})
