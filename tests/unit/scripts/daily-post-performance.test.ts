import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScrape } from '@/jobs/scrape'
import { snapshotFollowers } from '@/jobs/snapshot-followers'
import { completeText } from '@/lib/anthropic'
import { upsertCreator } from '@/lib/db/creators.repo'
import { getDb, resetDb } from '@/lib/db/db'
import { insertPosts } from '@/lib/db/posts.repo'
import { creatorGrowthDetail, type CreatorGrowthDetail } from '@/lib/followers-query'
import { setSettings } from '@/lib/settings'
import { embedTexts } from '@/lib/voyage'
import { run } from '@/scripts/daily-post-performance'
import { makePostRow } from '@/tests/fixtures/posts'
import type { ScrapeStats } from '@/lib/types'

// The whole job layer is mocked; the DB and the log file are real.
vi.mock('@/jobs/scrape', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/scrape')>()
  return { ...actual, runScrape: vi.fn() }
})
vi.mock('@/jobs/snapshot-followers', () => ({ snapshotFollowers: vi.fn() }))
vi.mock('@/lib/followers-query', () => ({ creatorGrowthDetail: vi.fn() }))
// Part A embeds via Voyage; Part B rewrites via Anthropic. Both are mocked — never hit for real.
vi.mock('@/lib/voyage', () => ({ embedTexts: vi.fn(), embedImage: vi.fn() }))
vi.mock('@/lib/anthropic', () => ({ completeText: vi.fn(), describeImage: vi.fn() }))

const mockRunScrape = vi.mocked(runScrape)
const mockSnapshot = vi.mocked(snapshotFollowers)
const mockGrowth = vi.mocked(creatorGrowthDetail)
const mockEmbed = vi.mocked(embedTexts)
const mockComplete = vi.mocked(completeText)

// A tiny 4-dim vector per known text so cosine is fully controllable: POST_TEXT == MATCH_DRAFT (1.0),
// both orthogonal to FAR_DRAFT (0.0).
const vecFor = (text: string): number[] => {
  if (text === 'POST_TEXT' || text === 'MATCH_DRAFT') return [1, 0, 0, 0]
  if (text === 'FAR_DRAFT') return [0, 1, 0, 0]
  return [0, 0, 1, 0]
}

const ZERO: ScrapeStats = {
  keyword_raw: 0,
  creator_raw: 0,
  merged_total: 0,
  duplicates: 0,
  found_in_both: 0,
  inserted: 0,
}

const OWN = 'basiakubicka'
const NOW = new Date('2026-09-10T08:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

let dir: string
let logPath: string

// A fresh, non-stale series with today's snapshot captured.
const freshSeries: CreatorGrowthDetail['series'] = [
  { captured_on: '2026-09-08', captured_at: '2026-09-08T08:00:00.000Z', followers: 10_000 },
  { captured_on: '2026-09-09', captured_at: '2026-09-09T08:00:00.000Z', followers: 10_200 },
  { captured_on: '2026-09-10', captured_at: '2026-09-10T08:00:00.000Z', followers: 10_540 },
]

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockRunScrape.mockResolvedValue(ZERO)
  mockSnapshot.mockResolvedValue({
    captured_on: '2026-09-10',
    requested: 1,
    captured: 1,
    skipped: [],
    missing: [],
    errors: [],
  })
  dir = mkdtempSync(join(tmpdir(), 'post-loop-'))
  logPath = join(dir, 'post-performance.jsonl')
  delete process.env.POST_LOOP_LOG_PATH
})
afterEach(() => {
  resetDb()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.POST_LOOP_LOG_PATH
})

/** Seed Basia's creator row + a post of hers ~23h old, plus decoy posts outside the window. */
const seedHerWindow = (): void => {
  upsertCreator({ platform: 'linkedin', profile_url: `https://www.linkedin.com/in/${OWN}`, author_id: OWN })
  insertPosts([
    makePostRow({ id: 'her-post', author_id: OWN, platform: 'linkedin', posted_at: at(23 * HOUR), likes: 812, comments: 44, shares: 12, x_factor: 2.1 }),
    makePostRow({ id: 'too-new', author_id: OWN, platform: 'linkedin', posted_at: at(5 * HOUR), likes: 10 }),
    makePostRow({ id: 'too-old', author_id: OWN, platform: 'linkedin', posted_at: at(40 * HOUR), likes: 10 }),
    makePostRow({ id: 'not-hers', author_id: 'someone', platform: 'linkedin', posted_at: at(23 * HOUR), likes: 10 }),
  ])
}

const readLines = (): Record<string, unknown>[] =>
  readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('daily-post-performance run()', () => {
  it('throws a clear error when no log path is given via arg or env', async () => {
    await expect(run({ now: NOW })).rejects.toThrow(/POST_LOOP_LOG_PATH|path/i)
  })

  it('re-scrapes only Basia, snapshots all creators, and logs one JSONL row per in-window post', async () => {
    seedHerWindow()
    const her = upsertCreator({ platform: 'linkedin', profile_url: `https://www.linkedin.com/in/${OWN}`, author_id: OWN })
    mockGrowth.mockReturnValue({
      author_id: OWN,
      series: freshSeries,
      days: [
        { captured_on: '2026-09-09', followers: 10_540, percent: 3.3, gained: 340, post_count: 1, shared: false, attributable_post_id: 'her-post' },
      ],
    })

    const rows = await run({ now: NOW, logPath })

    // Re-scrape targeted her creator row only.
    expect(mockRunScrape).toHaveBeenCalledTimes(1)
    expect(mockRunScrape.mock.calls[0]![0]).toMatchObject({ mode: 'creator', platforms: ['linkedin'], timeframe: '3d', creatorIds: [her.id] })
    // Follower snapshot batches everyone (not scoped down to her).
    expect(mockSnapshot).toHaveBeenCalledTimes(1)

    // Exactly one row: only her ~23h-old post is in the 20-30h window.
    expect(rows).toHaveLength(1)
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({
      logged_at: '2026-09-10T08:00:00.000Z',
      post_id: 'her-post',
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:her-post/',
      posted_at: at(23 * HOUR),
      hours_live: 23,
      likes: 812,
      comments: 44,
      shares: 12,
      x_factor: 2.1,
      performance_bucket: 'great',
      followers_gained_that_day: 340,
      followers_measurement_status: 'measured',
    })
  })

  it('carries a null gain with an explanatory status when the day is unmeasured', async () => {
    seedHerWindow()
    mockGrowth.mockReturnValue({ author_id: OWN, series: freshSeries, days: [] })

    await run({ now: NOW, logPath })

    const [row] = readLines()
    expect(row!.followers_gained_that_day).toBeNull()
    expect(row!.followers_measurement_status).toBe('unavailable')
  })

  it('is idempotent: a post already logged today is not logged twice', async () => {
    seedHerWindow()
    mockGrowth.mockReturnValue({
      author_id: OWN,
      series: freshSeries,
      days: [
        { captured_on: '2026-09-09', followers: 10_540, percent: 3.3, gained: 340, post_count: 1, shared: false, attributable_post_id: 'her-post' },
      ],
    })

    await run({ now: NOW, logPath })
    const second = await run({ now: NOW, logPath })

    expect(second).toHaveLength(0) // skipped on the second run
    expect(readLines()).toHaveLength(1)
  })

  it('reads the log path from POST_LOOP_LOG_PATH when no arg is passed', async () => {
    seedHerWindow()
    mockGrowth.mockReturnValue({ author_id: OWN, series: freshSeries, days: [] })
    process.env.POST_LOOP_LOG_PATH = logPath

    await run({ now: NOW })

    expect(existsSync(logPath)).toBe(true)
    expect(readLines()).toHaveLength(1)
  })
})

// ---- Part 2: draft matching (A) + audience-fit profile (B) ------------------------------------
describe('content-loop part 2', () => {
  const noAttribution = { author_id: OWN, series: freshSeries, days: [] }

  // A single in-window post of hers, content addressable by the embed mock.
  const seedHer = (overrides: Parameters<typeof makePostRow>[0] = {}): void => {
    upsertCreator({ platform: 'linkedin', profile_url: `https://www.linkedin.com/in/${OWN}`, author_id: OWN })
    insertPosts([
      makePostRow({
        id: 'her-post', author_id: OWN, platform: 'linkedin', posted_at: at(23 * HOUR),
        likes: 812, comments: 44, shares: 12, x_factor: 2.1, content: 'POST_TEXT', ...overrides,
      }),
    ])
  }

  const writeDrafts = (draftsDir: string, date: string, drafts: unknown[]): void => {
    mkdirSync(draftsDir, { recursive: true })
    writeFileSync(join(draftsDir, `${date}.json`), JSON.stringify({ date, drafts }))
  }

  afterEach(() => {
    delete process.env.DRAFTS_DIR
    delete process.env.AUDIENCE_PROFILE_DIR
  })

  describe('draft matching (Part A)', () => {
    it('matches a post to a stored draft above threshold and records the match', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor))
      const draftsDir = join(dir, 'drafts')
      writeDrafts(draftsDir, '2026-09-09', [
        { id: 'd1', archetype: 'tofu-contrarian', signal_source: 's', text: 'MATCH_DRAFT' },
        { id: 'd2', archetype: 'tofu-howto', signal_source: 's', text: 'FAR_DRAFT' },
      ])

      await run({ now: NOW, logPath, draftsDir })

      const [row] = readLines()
      expect(row!.matched_draft_id).toBe('d1')
      expect(row!.matched_draft_archetype).toBe('tofu-contrarian')
      expect(row!.draft_match_similarity as number).toBeGreaterThanOrEqual(0.55)
    })

    it('looks back across a 10-day window, not just the posted day', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor))
      const draftsDir = join(dir, 'drafts')
      // Drafted 5 days before she posted — must still be a candidate.
      writeDrafts(draftsDir, '2026-09-04', [{ id: 'older', archetype: 'tofu-story', signal_source: 's', text: 'MATCH_DRAFT' }])

      await run({ now: NOW, logPath, draftsDir })

      expect(readLines()[0]!.matched_draft_id).toBe('older')
    })

    it('records an explicit null match when the best draft is below threshold', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor))
      const draftsDir = join(dir, 'drafts')
      writeDrafts(draftsDir, '2026-09-09', [{ id: 'd2', archetype: 'tofu-howto', signal_source: 's', text: 'FAR_DRAFT' }])

      await run({ now: NOW, logPath, draftsDir })

      const [row] = readLines()
      expect(row!.matched_draft_id).toBeNull()
      expect(row!.matched_draft_archetype).toBeNull()
      expect(row!.draft_match_similarity).toBeNull()
    })

    it('skips draft matching and omits the fields entirely when DRAFTS_DIR is unset', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)

      await run({ now: NOW, logPath })

      const [row] = readLines()
      expect(mockEmbed).not.toHaveBeenCalled()
      expect('matched_draft_id' in row!).toBe(false)
      expect('matched_draft_archetype' in row!).toBe(false)
      expect('draft_match_similarity' in row!).toBe(false)
    })

    it('records a null match (no crash, no embed) when no draft file exists in the window', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor))
      const draftsDir = join(dir, 'drafts')
      mkdirSync(draftsDir, { recursive: true }) // empty dir, no dated files

      await run({ now: NOW, logPath, draftsDir })

      const [row] = readLines()
      expect(row!.matched_draft_id).toBeNull()
      expect(mockEmbed).not.toHaveBeenCalled()
    })

    it('treats an embed failure as a null match without failing other posts in the run', async () => {
      upsertCreator({ platform: 'linkedin', profile_url: `https://www.linkedin.com/in/${OWN}`, author_id: OWN })
      insertPosts([
        makePostRow({ id: 'post-a', author_id: OWN, platform: 'linkedin', posted_at: at(23 * HOUR), likes: 812, comments: 44, shares: 12, x_factor: 2.1, content: 'POST_TEXT' }),
        makePostRow({ id: 'post-b', author_id: OWN, platform: 'linkedin', posted_at: at(24 * HOUR), likes: 300, content: 'POST_TEXT' }),
      ])
      mockGrowth.mockReturnValue(noAttribution)
      mockEmbed.mockRejectedValue(new Error('Voyage API key is not set'))
      const draftsDir = join(dir, 'drafts')
      writeDrafts(draftsDir, '2026-09-09', [{ id: 'd1', archetype: 'a', signal_source: 's', text: 'MATCH_DRAFT' }])

      const rows = await run({ now: NOW, logPath, draftsDir })

      expect(rows).toHaveLength(2)
      const lines = readLines()
      expect(lines).toHaveLength(2)
      expect(lines.every((r) => r.matched_draft_id === null)).toBe(true)
    })
  })

  describe('audience-fit profile (Part B)', () => {
    it('folds a first 500+ like post into the profile and marks it processed', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      setSettings({ anthropic_api_key: 'sk-test' })
      mockComplete.mockResolvedValue('# Audience fit\n\nUpdated with the new post.')
      const profileDir = join(dir, 'profile')

      await run({ now: NOW, logPath, audienceProfileDir: profileDir })

      expect(mockComplete).toHaveBeenCalledTimes(1)
      const prompt = mockComplete.mock.calls[0]![0].prompt
      expect(prompt).toContain('POST_TEXT')
      expect(prompt).toContain('812')
      expect(readFileSync(join(profileDir, 'audience-fit-profile.md'), 'utf8')).toContain('Updated with the new post')
      expect(JSON.parse(readFileSync(join(profileDir, 'processed-post-ids.json'), 'utf8'))).toEqual(['her-post'])
      expect(readLines()).toHaveLength(1) // the performance row is still logged
    })

    it('passes the matched archetype + an "edited before posting" note into the rewrite when Part A matched', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor))
      setSettings({ anthropic_api_key: 'sk-test' })
      mockComplete.mockResolvedValue('updated')
      const draftsDir = join(dir, 'drafts')
      const profileDir = join(dir, 'profile')
      writeDrafts(draftsDir, '2026-09-09', [{ id: 'd1', archetype: 'tofu-contrarian', signal_source: 's', text: 'MATCH_DRAFT' }])

      await run({ now: NOW, logPath, draftsDir, audienceProfileDir: profileDir })

      const prompt = mockComplete.mock.calls[0]![0].prompt
      expect(prompt).toContain('tofu-contrarian')
      expect(prompt.toLowerCase()).toContain('edited')
    })

    it('does not touch the profile for a post below 500 likes', async () => {
      seedHer({ likes: 100 })
      mockGrowth.mockReturnValue(noAttribution)
      setSettings({ anthropic_api_key: 'sk-test' })
      const profileDir = join(dir, 'profile')

      await run({ now: NOW, logPath, audienceProfileDir: profileDir })

      expect(mockComplete).not.toHaveBeenCalled()
      expect(existsSync(join(profileDir, 'audience-fit-profile.md'))).toBe(false)
    })

    it('skips a post already recorded in the processed manifest (idempotent, no LLM call)', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      setSettings({ anthropic_api_key: 'sk-test' })
      const profileDir = join(dir, 'profile')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'processed-post-ids.json'), JSON.stringify(['her-post']))
      writeFileSync(join(profileDir, 'audience-fit-profile.md'), 'ORIGINAL')

      await run({ now: NOW, logPath, audienceProfileDir: profileDir })

      expect(mockComplete).not.toHaveBeenCalled()
      expect(readFileSync(join(profileDir, 'audience-fit-profile.md'), 'utf8')).toBe('ORIGINAL')
    })

    it('skips Part B entirely when AUDIENCE_PROFILE_DIR is unset', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      setSettings({ anthropic_api_key: 'sk-test' })

      await run({ now: NOW, logPath })

      expect(mockComplete).not.toHaveBeenCalled()
    })

    it('skips Part B without throwing (and still logs the row) when no Anthropic key is configured', async () => {
      seedHer()
      mockGrowth.mockReturnValue(noAttribution)
      const profileDir = join(dir, 'profile')

      const rows = await run({ now: NOW, logPath, audienceProfileDir: profileDir })

      expect(mockComplete).not.toHaveBeenCalled()
      expect(rows).toHaveLength(1)
      expect(existsSync(join(profileDir, 'audience-fit-profile.md'))).toBe(false)
    })
  })

  it('reads DRAFTS_DIR and AUDIENCE_PROFILE_DIR from env vars when not passed as opts', async () => {
    seedHer()
    mockGrowth.mockReturnValue(noAttribution)
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor))
    setSettings({ anthropic_api_key: 'sk-test' })
    mockComplete.mockResolvedValue('updated')
    const draftsDir = join(dir, 'drafts')
    const profileDir = join(dir, 'profile')
    writeDrafts(draftsDir, '2026-09-09', [{ id: 'd1', archetype: 'tofu-contrarian', signal_source: 's', text: 'MATCH_DRAFT' }])
    process.env.DRAFTS_DIR = draftsDir
    process.env.AUDIENCE_PROFILE_DIR = profileDir

    await run({ now: NOW, logPath })

    expect(readLines()[0]!.matched_draft_id).toBe('d1')
    expect(mockComplete).toHaveBeenCalledTimes(1)
    expect(existsSync(join(profileDir, 'audience-fit-profile.md'))).toBe(true)
  })
})
