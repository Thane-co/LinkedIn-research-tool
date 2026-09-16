import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeInstagramVideos } from '@/jobs/transcribe'
import { AudioUnavailableError, transcribeAudio } from '@/lib/assemblyai'
import { getDb, resetDb } from '@/lib/db/db'
import { getVideoPostsMissingTranscript, insertPosts, searchPosts } from '@/lib/db/posts.repo'
import { setSettings } from '@/lib/settings'
import { makePostRow } from '@/tests/fixtures/posts'

// Mock only the network call; keep AudioUnavailableError real so `instanceof` still discriminates.
vi.mock('@/lib/assemblyai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assemblyai')>()
  return { ...actual, transcribeAudio: vi.fn() }
})
const mockTranscribe = vi.mocked(transcribeAudio)

const video = (url: string) => JSON.stringify({ type: 'video', url, poster: 'https://p' })

const vpost = (code: string, over = {}) =>
  makePostRow({
    id: `instagram-${code}`,
    platform: 'instagram',
    media: video(`https://cdn/${code}.mp4`),
    url: `https://www.instagram.com/reel/${code}/`,
    transcript: null,
    ...over,
  })

const result = (text: string | null) => ({
  id: 't', status: 'completed' as const, text, audio_duration: 30, sentiment_analysis_results: null,
})

const transcriptOf = (id: string): string | null =>
  searchPosts({ platforms: ['instagram'] }).posts.find((p) => p.id === id)!.transcript

beforeEach(() => {
  getDb(':memory:')
  vi.clearAllMocks()
  setSettings({ assemblyai_api_key: 'ak' })
})
afterEach(() => resetDb())

describe('transcribeInstagramVideos (§18) — AssemblyAI', () => {
  it('transcribes each video from its direct media url', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    mockTranscribe.mockImplementation(async (url) => result(`text for ${url}`))

    const res = await transcribeInstagramVideos(10)

    expect(mockTranscribe).toHaveBeenCalledWith('https://cdn/AAA.mp4')
    expect(mockTranscribe).toHaveBeenCalledWith('https://cdn/BBB.mp4')
    expect(res).toEqual({ transcribed: 2, remaining: 0, unavailable: 0 })
    expect(transcriptOf('instagram-AAA')).toBe('text for https://cdn/AAA.mp4')
  })

  it('marks a clip with no speech as "" so it is never re-attempted (§18)', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    mockTranscribe.mockImplementation(async (url) => result(url.includes('AAA') ? 'has speech' : '   '))

    const res = await transcribeInstagramVideos(10)
    expect(res.transcribed).toBe(1)
    expect(res.remaining).toBe(0)
    expect(transcriptOf('instagram-BBB')).toBe('')
    expect(getVideoPostsMissingTranscript(10)).toHaveLength(0)
  })

  it('leaves an EXPIRED media url as NULL and counts it unavailable — re-scrape, do not mark done', async () => {
    insertPosts([vpost('AAA'), vpost('BBB')])
    mockTranscribe.mockImplementation(async (url) => {
      if (url.includes('BBB')) throw new AudioUnavailableError('Download error, 403')
      return result('has speech')
    })

    const res = await transcribeInstagramVideos(10)
    expect(res).toEqual({ transcribed: 1, remaining: 1, unavailable: 1 })
    expect(transcriptOf('instagram-BBB')).toBeNull() // retried after a fresh scrape
  })

  it('keeps going after one clip fails — one bad clip never aborts the batch', async () => {
    insertPosts([vpost('AAA'), vpost('BBB'), vpost('CCC')])
    mockTranscribe.mockImplementation(async (url) => {
      if (url.includes('BBB')) throw new Error('assemblyai boom')
      return result('ok')
    })

    const res = await transcribeInstagramVideos(10)
    expect(res.transcribed).toBe(2)
    expect(transcriptOf('instagram-BBB')).toBeNull()
  })

  it('skips a post whose stored media has no usable url', async () => {
    insertPosts([vpost('AAA', { media: JSON.stringify({ type: 'image', images: ['https://i'] }) })])
    const res = await transcribeInstagramVideos(10)
    expect(mockTranscribe).not.toHaveBeenCalled()
    expect(res.transcribed).toBe(0)
  })

  it('does nothing when no video post is missing a transcript', async () => {
    const res = await transcribeInstagramVideos(10)
    expect(mockTranscribe).not.toHaveBeenCalled()
    expect(res).toEqual({ transcribed: 0, remaining: 0, unavailable: 0 })
  })

  it('skips entirely (no API call) when the AssemblyAI key is unset', async () => {
    insertPosts([vpost('AAA')])
    setSettings({ assemblyai_api_key: '' })
    const res = await transcribeInstagramVideos(10)
    expect(mockTranscribe).not.toHaveBeenCalled()
    expect(res).toEqual({ transcribed: 0, remaining: 1, unavailable: 0 })
  })

  it('honours the limit so one batch stays bounded', async () => {
    insertPosts([vpost('AAA'), vpost('BBB'), vpost('CCC')])
    mockTranscribe.mockResolvedValue(result('ok'))
    const res = await transcribeInstagramVideos(2)
    expect(mockTranscribe).toHaveBeenCalledTimes(2)
    expect(res.remaining).toBe(1)
  })
})
