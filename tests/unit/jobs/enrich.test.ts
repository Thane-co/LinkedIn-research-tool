import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enrichPosts } from '@/jobs/enrich'
import { countUnembedded, getUnembedded, setEmbedding } from '@/lib/db/posts.repo'
import { embedImage, embedTexts } from '@/lib/voyage'
import { describeImage } from '@/lib/anthropic'
import { blobToVector } from '@/lib/pure/vector-blob'
import { makePostRow } from '@/tests/fixtures/posts'

// Enrich orchestrates repo + adapters; unit-test it with those mocked (PRD §12 step 20).
vi.mock('@/lib/db/posts.repo', () => ({
  getUnembedded: vi.fn(),
  countUnembedded: vi.fn(),
  setEmbedding: vi.fn(),
}))
vi.mock('@/lib/voyage', () => ({
  embedTexts: vi.fn(),
  embedImage: vi.fn(),
}))
vi.mock('@/lib/anthropic', () => ({
  describeImage: vi.fn(),
}))

const mocked = {
  getUnembedded: vi.mocked(getUnembedded),
  countUnembedded: vi.mocked(countUnembedded),
  setEmbedding: vi.mocked(setEmbedding),
  embedTexts: vi.mocked(embedTexts),
  embedImage: vi.mocked(embedImage),
  describeImage: vi.mocked(describeImage),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.countUnembedded.mockReturnValue(0)
  mocked.describeImage.mockResolvedValue(null) // descriptions OFF by default (v1)
})
afterEach(() => vi.restoreAllMocks())

describe('enrichPosts', () => {
  it('does nothing (and calls no adapter) when there are no unembedded posts', async () => {
    mocked.getUnembedded.mockReturnValue([])
    const res = await enrichPosts(50)
    expect(res).toEqual({ embedded: 0, remaining: 0 })
    expect(mocked.embedTexts).not.toHaveBeenCalled()
    expect(mocked.setEmbedding).not.toHaveBeenCalled()
  })

  it('embeds every unembedded post and writes the text blob + embedded_at', async () => {
    mocked.getUnembedded.mockReturnValue([
      makePostRow({ id: 'a', content: 'first', image_url: null }),
      makePostRow({ id: 'b', content: 'second', image_url: null }),
    ])
    mocked.embedTexts.mockResolvedValue([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ])
    mocked.countUnembedded.mockReturnValue(3)

    const res = await enrichPosts(50)

    expect(mocked.embedTexts).toHaveBeenCalledWith(['first', 'second'])
    expect(mocked.setEmbedding).toHaveBeenCalledTimes(2)
    // text-only posts write only the text blob (no image args)
    const [id0, blob0, embeddedAt0, img0, desc0] = mocked.setEmbedding.mock.calls[0]!
    expect(id0).toBe('a')
    expect(blobToVector(blob0)).toEqual([1, 0, 0, 0])
    expect(typeof embeddedAt0).toBe('string')
    expect(img0).toBeUndefined()
    expect(desc0).toBeUndefined()
    expect(res).toEqual({ embedded: 2, remaining: 3 })
  })

  it('never re-embeds by default, but passes the reEmbed flag through to the loader', async () => {
    mocked.getUnembedded.mockReturnValue([])
    await enrichPosts(10)
    expect(mocked.getUnembedded).toHaveBeenLastCalledWith(10, { reEmbed: false })

    await enrichPosts(10, { reEmbed: true })
    expect(mocked.getUnembedded).toHaveBeenLastCalledWith(10, { reEmbed: true })
  })

  it('embeds the image and preserves an existing description when Claude is disabled', async () => {
    mocked.getUnembedded.mockReturnValue([
      makePostRow({
        id: 'img',
        content: 'chart post',
        image_url: 'https://img/1.png',
        image_description: 'existing desc',
      }),
    ])
    mocked.embedTexts.mockResolvedValue([[1, 0, 0, 0]])
    mocked.embedImage.mockResolvedValue([0, 0, 1, 0])
    mocked.describeImage.mockResolvedValue(null) // feature off

    const res = await enrichPosts(50)

    expect(mocked.embedImage).toHaveBeenCalledWith('https://img/1.png')
    const [, , , imgBlob, desc] = mocked.setEmbedding.mock.calls[0]!
    expect(blobToVector(imgBlob as Buffer)).toEqual([0, 0, 1, 0])
    expect(desc).toBe('existing desc') // not wiped
    expect(res.embedded).toBe(1)
  })

  it('is non-fatal on a per-image failure — still writes the text embedding', async () => {
    mocked.getUnembedded.mockReturnValue([
      makePostRow({ id: 'img', content: 'x', image_url: 'https://img/broken.png' }),
    ])
    mocked.embedTexts.mockResolvedValue([[1, 0, 0, 0]])
    mocked.embedImage.mockRejectedValue(new Error('voyage image 500'))

    const res = await enrichPosts(50)

    expect(mocked.setEmbedding).toHaveBeenCalledTimes(1)
    const [id, textBlob] = mocked.setEmbedding.mock.calls[0]!
    expect(id).toBe('img')
    expect(blobToVector(textBlob)).toEqual([1, 0, 0, 0])
    expect(res.embedded).toBe(1)
  })
})
