import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeInstagramVideos } from '@/jobs/transcribe'
import { runActor } from '@/lib/apify'
import { getDb, resetDb } from '@/lib/db/db'
import { getVideoPostsMissingTranscript, insertPosts, searchPosts } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import { makePostRow } from '@/tests/fixtures/posts'
import type { ApifyInstagramTranscript } from '@/lib/types'

// Keep the pure input builder real; mock only the network run.
vi.mock('@/lib/apify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return { ...actual, runActor: vi.fn() }
})
const mockRunActor = vi.mocked(runActor)

const VIDEO = JSON.stringify({ type: 'video', url: 'https://v', poster: 'https://p' })

const vpost = (code: string, over = {}) =>
  makePostRow({
    id: `instagram-${code}`,
    platform: 'instagram',
    media: VIDEO,
    url: `https://www.instagram.com/reel/${code}/`,
    transcript: null,
    ...over,
  })

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  setSettings({ apify_api_token: 'tok', apify_instagram_transcript_actor_id: 'crawlerbros/instagram-transcript-scraper' })
})
afterEach(() => resetDb())

describe('transcribeInstagramVideos (§18)', () => {
  it('transcribes video posts and matches results back by shortCode', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    let sentInput: Record<string, unknown> | null = null
    mockRunActor.mockImplementation(async (_id, input: object) => {
      sentInput = input as Record<string, unknown>
      return [
        { shortCode: 'AAA', fullText: 'hello from AAA' },
        { shortCode: 'BBB', fullText: 'hello from BBB' },
      ] as ApifyInstagramTranscript[]
    })

    const res = await transcribeInstagramVideos(10)

    expect(sentInput!.videoUrls).toEqual([
      'https://www.instagram.com/reel/AAA/',
      'https://www.instagram.com/reel/BBB/',
    ])
    expect(res.transcribed).toBe(2)
    expect(res.remaining).toBe(0)
    const byId = Object.fromEntries(searchPosts({}).posts.map((p) => [p.id, p.transcript]))
    expect(byId['instagram-AAA']).toBe('hello from AAA')
    expect(byId['instagram-BBB']).toBe('hello from BBB')
  })

  it('falls back to matching by postUrl when shortCode is absent', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    mockRunActor.mockResolvedValue([
      { postUrl: 'https://www.instagram.com/reel/AAA/', fullText: 'matched by url' },
      { shortCode: 'BBB', fullText: 'real text' },
    ] as ApifyInstagramTranscript[])

    const res = await transcribeInstagramVideos(10)
    expect(res.transcribed).toBe(2)
    expect(searchPosts({ platforms: ['instagram'] }).posts.find((p) => p.id === 'instagram-AAA')!.transcript).toBe(
      'matched by url',
    )
  })

  it('marks a video the actor returned EMPTY as "no speech" ("") so it is not re-attempted (§18)', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    mockRunActor.mockResolvedValue([
      { shortCode: 'AAA', fullText: 'has speech' },
      { shortCode: 'BBB', fullText: '   ' }, // actor processed it but found no speech
    ] as ApifyInstagramTranscript[])

    const res = await transcribeInstagramVideos(10)
    expect(res.transcribed).toBe(1) // only AAA counts as transcribed
    expect(res.remaining).toBe(0) // BBB is marked '' → no longer "missing", won't retry
    expect(getVideoPostsMissingTranscript(10)).toHaveLength(0)
    expect(searchPosts({ platforms: ['instagram'] }).posts.find((p) => p.id === 'instagram-BBB')!.transcript).toBe('')
  })

  it('leaves a video the actor did NOT return as NULL (still retried later) (§18)', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    mockRunActor.mockResolvedValue([
      { shortCode: 'AAA', fullText: 'has speech' },
      // BBB absent from results entirely → not attempted → stays NULL
    ] as ApifyInstagramTranscript[])

    const res = await transcribeInstagramVideos(10)
    expect(res.transcribed).toBe(1)
    expect(res.remaining).toBe(1) // BBB still missing → will be retried
    expect(searchPosts({ platforms: ['instagram'] }).posts.find((p) => p.id === 'instagram-BBB')!.transcript).toBeNull()
  })

  it('does nothing (no actor call) when there are no video posts missing a transcript', async () => {
    const res = await transcribeInstagramVideos(10)
    expect(mockRunActor).not.toHaveBeenCalled()
    expect(res).toEqual({ transcribed: 0, remaining: 0 })
  })

  it('is non-fatal when the actor throws — returns 0 transcribed, leaves posts unchanged', async () => {
    insertPosts([vpost('AAA')])
    mockRunActor.mockRejectedValue(new Error('actor boom'))
    const res = await transcribeInstagramVideos(10)
    expect(res.transcribed).toBe(0)
    expect(res.remaining).toBe(1)
    expect(getVideoPostsMissingTranscript(10)).toHaveLength(1) // still awaiting
  })

  it('skips (no actor call) when the transcript actor id is unset', async () => {
    insertPosts([vpost('AAA')])
    setSettings({ apify_instagram_transcript_actor_id: '' })
    const res = await transcribeInstagramVideos(10)
    expect(mockRunActor).not.toHaveBeenCalled()
    expect(res.transcribed).toBe(0)
  })
})
