// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackedCreatorPicker } from '@/app/TrackedCreatorPicker'
import { apiFetch } from '@/lib/api-client'

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, apiFetch: vi.fn() }
})
const mockApiFetch = vi.mocked(apiFetch)

const roster = (over = {}) => ({
  creators: [
    { id: 'c1', author_id: 'jane', display_name: 'Jane', avatar_url: null, tracked: true, followers: 90_000, posts_30d: 20, best_x_factor: 3.2 },
    { id: 'c2', author_id: 'bob', display_name: 'Bob', avatar_url: null, tracked: false, followers: 12_000, posts_30d: 4, best_x_factor: 1.1 },
  ],
  total: 2,
  tracked_count: 1,
  monthly_cost: 0.12,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockApiFetch.mockResolvedValue(roster())
})
afterEach(() => vi.restoreAllMocks())

describe('TrackedCreatorPicker', () => {
  it('lists every creator with a checkbox reflecting whether they are tracked', async () => {
    render(<TrackedCreatorPicker onChanged={vi.fn()} />)

    const jane = await screen.findByRole('checkbox', { name: /Jane/ })
    expect((jane as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /Bob/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('shows the running monthly cost of the current selection', async () => {
    render(<TrackedCreatorPicker onChanged={vi.fn()} />)
    expect(await screen.findByText(/1 of 2 tracked/i)).toBeTruthy()
    expect(screen.getByText(/\$0\.12\/month/)).toBeTruthy()
  })

  it('persists a toggle and tells the board to reload', async () => {
    const onChanged = vi.fn()
    render(<TrackedCreatorPicker onChanged={onChanged} />)
    await screen.findByRole('checkbox', { name: /Bob/ })

    await userEvent.click(screen.getByRole('checkbox', { name: /Bob/ }))

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/creators/tracking',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ id: 'c2', tracked: true }) }),
      ),
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('filters the list by name so a 67-row roster is navigable', async () => {
    render(<TrackedCreatorPicker onChanged={vi.fn()} />)
    await screen.findByRole('checkbox', { name: /Jane/ })

    await userEvent.type(screen.getByRole('searchbox', { name: /filter/i }), 'bob')

    expect(screen.queryByRole('checkbox', { name: /Jane/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Bob/ })).toBeTruthy()
  })

  it('renders an error instead of a blank list when the roster fails to load', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'))
    render(<TrackedCreatorPicker onChanged={vi.fn()} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('reverts the checkbox when saving fails, so the UI never lies about what is tracked', async () => {
    render(<TrackedCreatorPicker onChanged={vi.fn()} />)
    const bob = await screen.findByRole('checkbox', { name: /Bob/ })
    mockApiFetch.mockRejectedValueOnce(new Error('save failed'))

    await userEvent.click(bob)

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect((screen.getByRole('checkbox', { name: /Bob/ }) as HTMLInputElement).checked).toBe(false)
  })
})
