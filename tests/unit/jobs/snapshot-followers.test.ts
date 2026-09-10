import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotFollowers } from '@/jobs/snapshot-followers'
import { runActor } from '@/lib/apify'
import { setCreatorTracking, upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { countSnapshots, getSnapshots } from '@/lib/db/followers.repo'
import { getProfile } from '@/lib/db/profiles.repo'
import { setSettings } from '@/lib/settings'
import type { ApifyProfile } from '@/lib/types'

vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  setSettings({ apify_profile_detail_actor_id: 'harvestapi/linkedin-profile-scraper' })
})
afterEach(() => resetDb())

const item = (publicIdentifier: string, followerCount: number): ApifyProfile => ({
  publicIdentifier,
  linkedinUrl: `https://www.linkedin.com/in/${publicIdentifier}/`,
  firstName: publicIdentifier,
  lastName: 'X',
  followerCount,
  connectionsCount: 500,
})

// Creators are opt-in for follower tracking (§21.8), so the fixture turns the flag on by default;
// the "untracked" test below is the one that leaves it off.
const addCreator = (author_id: string, platform: 'linkedin' | 'twitter' = 'linkedin', tracked = true) => {
  const row = upsertCreator({
    platform,
    profile_url: `https://www.linkedin.com/in/${author_id}`,
    author_id,
    display_name: author_id,
  })
  if (tracked) setCreatorTracking(row.id, true)
  return row
}

describe('snapshotFollowers (§21)', () => {
  it('captures one snapshot per core LinkedIn creator', async () => {
    addCreator('jane')
    addCreator('bob')
    mockRunActor.mockResolvedValue([item('jane', 12_000), item('bob', 3_000)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.captured).toBe(2)
    expect(getSnapshots('jane', 'linkedin')).toEqual([
      { captured_on: '2026-09-09', captured_at: '2026-09-09T06:00:00.000Z', followers: 12_000 },
    ])
  })

  it('sends every creator in ONE actor run, not one run per creator', async () => {
    addCreator('jane')
    addCreator('bob')
    mockRunActor.mockResolvedValue([item('jane', 1), item('bob', 2)])

    await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(mockRunActor).toHaveBeenCalledTimes(1)
    const [, input] = mockRunActor.mock.calls[0]!
    // Sorted by author_id so chunk boundaries are deterministic across runs.
    expect((input as { queries: string[] }).queries).toEqual([
      'https://www.linkedin.com/in/bob',
      'https://www.linkedin.com/in/jane',
    ])
  })

  it('chunks a roster larger than the batch size across runs', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) addCreator(n)
    mockRunActor.mockResolvedValue([])

    await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z', batchSize: 2 })

    expect(mockRunActor).toHaveBeenCalledTimes(3) // 2 + 2 + 1
  })

  it('refreshes the profiles table too — the actor already returned the full detail', async () => {
    addCreator('jane')
    mockRunActor.mockResolvedValue([item('jane', 12_000)])

    await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(getProfile('jane')?.followers).toBe(12_000)
  })

  it('skips a profile that came back with no follower count rather than storing a zero', async () => {
    addCreator('jane')
    addCreator('ghost')
    mockRunActor.mockResolvedValue([item('jane', 12_000), item('ghost', 0)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.captured).toBe(1)
    expect(res.skipped).toEqual(['ghost'])
    expect(getSnapshots('ghost', 'linkedin')).toEqual([])
  })

  it('reports creators the actor never returned, so a silent roster gap is visible', async () => {
    addCreator('jane')
    addCreator('missing')
    mockRunActor.mockResolvedValue([item('jane', 12_000)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.missing).toEqual(['missing'])
  })

  it('a failed chunk never aborts the run — the other chunks still commit', async () => {
    for (const n of ['a', 'b', 'c', 'd']) addCreator(n)
    mockRunActor
      .mockRejectedValueOnce(new Error('actor 500'))
      .mockResolvedValueOnce([item('c', 300), item('d', 400)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z', batchSize: 2 })

    expect(res.captured).toBe(2)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toContain('actor 500')
  })

  it('captures ONLY the tracked subset — the scrape roster is a different list', async () => {
    addCreator('tracked')
    addCreator('research-only', 'linkedin', false)
    mockRunActor.mockResolvedValue([item('tracked', 5_000)])

    const res = await snapshotFollowers({ asOf: '2026-09-10T06:00:00.000Z' })

    expect(res.requested).toBe(1)
    const [, input] = mockRunActor.mock.calls[0]!
    expect((input as { queries: string[] }).queries).toEqual(['https://www.linkedin.com/in/tracked'])
  })

  it('does nothing (and spends nothing) when no creator is tracked yet', async () => {
    addCreator('research-only', 'linkedin', false)
    const res = await snapshotFollowers({ asOf: '2026-09-10T06:00:00.000Z' })
    expect(res.requested).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('ignores non-LinkedIn creators — this is a LinkedIn-only capture', async () => {
    addCreator('tweeter', 'twitter')
    mockRunActor.mockResolvedValue([])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.requested).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('re-running the same day refreshes rather than duplicating', async () => {
    addCreator('jane')
    mockRunActor.mockResolvedValue([item('jane', 12_000)])
    await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })
    mockRunActor.mockResolvedValue([item('jane', 12_050)])
    await snapshotFollowers({ asOf: '2026-09-09T20:00:00.000Z' })

    expect(countSnapshots()).toBe(1)
    expect(getSnapshots('jane', 'linkedin')[0]?.followers).toBe(12_050)
  })

  it('derives the slug from the profile url when a creator has no author_id yet', async () => {
    setCreatorTracking(
      upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/in/slugonly', display_name: 'Slug' }).id,
      true,
    )
    mockRunActor.mockResolvedValue([item('slugonly', 5_000)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.requested).toBe(1)
    expect(res.missing).toEqual([])
    expect(getSnapshots('slugonly', 'linkedin')[0]?.followers).toBe(5_000)
  })

  it('skips a creator whose profile url has no /in/ segment rather than sending a junk query', async () => {
    setCreatorTracking(
      upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/company/acme' }).id,
      true,
    )
    mockRunActor.mockResolvedValue([])

    expect((await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })).requested).toBe(0)
    expect(mockRunActor).not.toHaveBeenCalled()
  })

  it('falls back to the raw slug when the url carries a malformed percent-escape', async () => {
    setCreatorTracking(
      upsertCreator({ platform: 'linkedin', profile_url: 'https://www.linkedin.com/in/bad%zz' }).id,
      true,
    )
    mockRunActor.mockResolvedValue([item('bad%zz', 4_000)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.requested).toBe(1)
    expect(res.captured).toBe(1)
  })

  it('skips an unmappable item without losing the rest of the batch', async () => {
    addCreator('jane')
    // No publicIdentifier and no parseable linkedinUrl — the mapper throws on this one.
    mockRunActor.mockResolvedValue([{ followerCount: 10 } as ApifyProfile, item('jane', 12_000)])

    const res = await snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })

    expect(res.captured).toBe(1)
    expect(getSnapshots('jane', 'linkedin')[0]?.followers).toBe(12_000)
  })

  it('throws a clear error when no profile-detail actor is configured', async () => {
    setSettings({ apify_profile_detail_actor_id: '' })
    addCreator('jane')
    await expect(snapshotFollowers({ asOf: '2026-09-09T06:00:00.000Z' })).rejects.toThrow(/actor/i)
  })
})
