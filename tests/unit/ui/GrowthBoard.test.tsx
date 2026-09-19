// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrowthBoard } from '@/app/GrowthBoard'
import { apiFetch } from '@/lib/api-client'
import type { Leaderboard } from '@/lib/followers-query'

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockApiFetch = vi.mocked(apiFetch)

const row = (author_id: string, over: Partial<Leaderboard['absolute'][number]> = {}) => ({
  author_id,
  display_name: author_id,
  avatar_url: null,
  followers: 20_000,
  gained: 500,
  percent: 2.5,
  stale: false,
  approx: false,
  posts: 1,
  best_x_score: 3.2,
  rank: 1,
  spark: [19_500, 20_000],
  ...over,
})

const board = (over: Partial<Leaderboard> = {}): Leaderboard => ({
  as_of: '2026-09-09',
  window_days: 1,
  percent_floor: 10_000,
  absolute: [row('jane')],
  percent: [row('jane')],
  coverage: { creators: 67, measured: 66 },
  ...over,
})

const emptyRoster = { creators: [], total: 0, tracked_count: 0, monthly_cost: 0 }

/**
 * The board and the tracked-creator picker both fetch on mount, so the mock has to answer per url —
 * a blanket mockResolvedValue would hand the picker a Leaderboard.
 */
function mockRoutes(boardBody: Leaderboard = board()): void {
  mockApiFetch.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/api/creators/tracking') ? emptyRoster : boardBody),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRoutes()
})
afterEach(() => vi.restoreAllMocks())

describe('GrowthBoard', () => {
  it('loads the 1-day board on mount and renders both leaderboards', async () => {
    render(<GrowthBoard />)

    expect(await screen.findByRole('table', { name: /followers gained/i })).toBeTruthy()
    expect(screen.getByRole('table', { name: /fastest % growth/i })).toBeTruthy()
    expect(mockApiFetch).toHaveBeenCalledWith('/api/followers?window=1')
  })

  it('refetches when the window changes', async () => {
    render(<GrowthBoard />)
    await screen.findByRole('table', { name: /followers gained/i })

    const windows = screen.getByRole('group', { name: /leaderboard window/i })
    await userEvent.click(within(windows).getByRole('button', { name: '7d' }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/followers?window=7'))
  })

  it('shows the follower floor so an absent creator on the % board is explained, not mysterious', async () => {
    render(<GrowthBoard />)
    expect(await screen.findByText(/10,000\+ followers/i)).toBeTruthy()
  })

  it('renders a dash for a creator with no history instead of a zero', async () => {
    mockRoutes(
      board({ absolute: [row('newbie', { gained: null, percent: null, spark: [] })], percent: [] }),
    )
    render(<GrowthBoard />)

    const table = await screen.findByRole('table', { name: /followers gained/i })
    const cells = within(table).getAllByRole('cell')
    expect(cells.some((c) => c.textContent === '—')).toBe(true)
    expect(cells.some((c) => c.textContent === '0')).toBe(false)
  })

  it('signs a gain and a loss differently', async () => {
    mockRoutes(
      board({ absolute: [row('up', { gained: 500 }), row('down', { gained: -120, rank: 2 })], percent: [] }),
    )
    render(<GrowthBoard />)

    expect(await screen.findByText('+500')).toBeTruthy()
    expect(screen.getByText('-120')).toBeTruthy()
  })

  it('marks an approximate gain so a long baseline gap is never read as one window of growth', async () => {
    mockRoutes(
      board({ absolute: [row('seeded', { approx: true, gained: 4_000 })], percent: [] }),
    )
    render(<GrowthBoard />)

    expect(await screen.findByText('~+4,000')).toBeTruthy()
    expect(screen.getByTitle(/longer than the selected window/i)).toBeTruthy()
  })

  it('flags a stale row so last-known numbers are never read as current', async () => {
    mockRoutes(board({ absolute: [row('old', { stale: true })], percent: [] }))
    render(<GrowthBoard />)
    expect(await screen.findByTitle(/last captured/i)).toBeTruthy()
  })

  it('reports capture coverage so a half-captured day is visible', async () => {
    render(<GrowthBoard />)
    expect(await screen.findByText(/66 of 67 creators/i)).toBeTruthy()
  })

  it('opens the day-by-day panel for a creator when their name is clicked', async () => {
    render(<GrowthBoard />)
    await screen.findByRole('table', { name: /followers gained/i })

    await userEvent.click(screen.getAllByRole('button', { name: 'jane' })[0]!)

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/followers/jane?days=30'))
  })

  it('renders an error state instead of a blank board when the fetch fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'))
    render(<GrowthBoard />)
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0)
  })

  it('captures today on demand and reloads the board', async () => {
    render(<GrowthBoard />)
    await screen.findByRole('table', { name: /followers gained/i })
    mockApiFetch.mockClear()
    mockRoutes()

    await userEvent.click(screen.getByRole('button', { name: /capture today/i }))

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/followers/snapshot', expect.objectContaining({ method: 'POST' })),
    )
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/followers?window=1'))
  })
})
