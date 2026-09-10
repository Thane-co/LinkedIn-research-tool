// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreatorGrowthPanel } from '@/app/CreatorGrowthPanel'
import { apiFetch } from '@/lib/api-client'
import type { CreatorGrowthDetail } from '@/lib/followers-query'

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockApiFetch = vi.mocked(apiFetch)

const detail = (over: Partial<CreatorGrowthDetail> = {}): CreatorGrowthDetail => ({
  author_id: 'jane',
  series: [],
  days: [
    {
      captured_on: '2026-09-09',
      followers: 20_500,
      percent: 2.5,
      gained: 412,
      post_count: 1,
      shared: false,
      attributable_post_id: 'p1',
    },
  ],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockApiFetch.mockResolvedValue(detail())
})
afterEach(() => vi.restoreAllMocks())

describe('CreatorGrowthPanel', () => {
  it('loads the creator series on mount', async () => {
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)
    expect(await screen.findByText(/Jane/)).toBeTruthy()
    expect(mockApiFetch).toHaveBeenCalledWith('/api/followers/jane?days=30')
  })

  it('credits a single-post day to that post', async () => {
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)
    expect(await screen.findByText('+412')).toBeTruthy()
    expect(screen.getByRole('link', { name: /view post/i })).toBeTruthy()
  })

  it('says a multi-post day is shared instead of inventing a split', async () => {
    mockApiFetch.mockResolvedValue(
      detail({
        days: [
          {
            captured_on: '2026-09-09',
            followers: 20_500,
            percent: 2.5,
            gained: 412,
            post_count: 3,
            shared: true,
            attributable_post_id: null,
          },
        ],
      }),
    )
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)

    expect(await screen.findByText(/shared across 3 posts/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /view post/i })).toBeNull()
  })

  it('labels a no-post day rather than hiding its growth', async () => {
    mockApiFetch.mockResolvedValue(
      detail({
        days: [
          {
            captured_on: '2026-09-09',
            followers: 20_500,
            percent: 2.5,
            gained: 300,
            post_count: 0,
            shared: false,
            attributable_post_id: null,
          },
        ],
      }),
    )
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)

    expect(await screen.findByText('+300')).toBeTruthy()
    expect(screen.getByText(/no posts/i)).toBeTruthy()
  })

  it('survives a response missing its days array instead of blanking the panel', async () => {
    // A malformed/partial body must degrade to "no history", never to a render crash.
    mockApiFetch.mockResolvedValue({ author_id: 'jane' } as unknown as CreatorGrowthDetail)
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)
    expect(await screen.findByText(/no daily history yet/i)).toBeTruthy()
  })

  it('renders an error state instead of a blank panel', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'))
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('says so plainly when the creator has no history yet', async () => {
    mockApiFetch.mockResolvedValue(detail({ days: [] }))
    render(<CreatorGrowthPanel authorId="jane" displayName="Jane" onClose={vi.fn()} />)
    expect(await screen.findByText(/no daily history yet/i)).toBeTruthy()
  })
})
