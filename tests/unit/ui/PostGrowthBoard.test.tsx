// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostGrowthBoard } from '@/app/PostGrowthBoard'
import { apiFetch } from '@/lib/api-client'

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockApiFetch = vi.mocked(apiFetch)

const row = (over = {}) => ({
  id: 'p1', author_id: 'jane', author_name: 'Jane', url: 'https://li/p1',
  content: 'A post about AI agents that goes on for a while',
  posted_at: '2026-09-08T09:00:00.000Z', x_factor: 2.4, current_total: 420,
  day1: 100, day2: 300, day3: 420, gained_today: 120,
  still_climbing: true, pct_after_day1: 76.2,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockApiFetch.mockResolvedValue({ days: 7, posts: [row()] })
})
afterEach(() => vi.restoreAllMocks())

describe('PostGrowthBoard', () => {
  it('loads recent post growth on mount', async () => {
    render(<PostGrowthBoard />)
    expect(await screen.findByRole('table', { name: /post growth/i })).toBeTruthy()
    expect(mockApiFetch).toHaveBeenCalledWith('/api/post-growth?days=7')
  })

  it('shows day 1, 2 and 3 side by side so posts compare at equal age', async () => {
    render(<PostGrowthBoard />)
    await screen.findByRole('table', { name: /post growth/i })
    for (const v of ['100', '300', '420']) expect(screen.getAllByText(v).length).toBeGreaterThan(0)
  })

  it('flags a post that is still climbing', async () => {
    render(<PostGrowthBoard />)
    expect(await screen.findByTitle(/still gaining/i)).toBeTruthy()
  })

  it('renders a dash for a day the post is too young to have', async () => {
    mockApiFetch.mockResolvedValue({ days: 7, posts: [row({ day2: null, day3: null, gained_today: null })] })
    render(<PostGrowthBoard />)
    await screen.findByRole('table', { name: /post growth/i })
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('refetches when the window changes', async () => {
    render(<PostGrowthBoard />)
    await screen.findByRole('table', { name: /post growth/i })
    const windows = screen.getByRole('group', { name: /post window/i })
    await userEvent.click(within(windows).getByRole('button', { name: '3d' }))
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/post-growth?days=3'))
  })

  it('renders an error state rather than a blank table', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'))
    render(<PostGrowthBoard />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('survives a response with no posts array', async () => {
    mockApiFetch.mockResolvedValue({ days: 7 } as never)
    render(<PostGrowthBoard />)
    expect(await screen.findByText(/nothing measured yet/i)).toBeTruthy()
  })
})
