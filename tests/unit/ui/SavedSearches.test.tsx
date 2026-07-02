// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SavedSearches } from '@/app/SavedSearches'
import { server } from '@/tests/msw/server'

const search = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Viral AI',
  params: JSON.stringify({ platform: 'linkedin', minLikes: 500 }),
  created_at: 't',
  ...over,
})

afterEach(() => server.resetHandlers())

describe('SavedSearches', () => {
  it('applies a saved preset params via onApply', async () => {
    const onApply = vi.fn()
    server.use(http.get('*/api/saved-searches', () => HttpResponse.json({ searches: [search()] })))
    render(<SavedSearches current={{ platform: 'all' }} onApply={onApply} />)
    await userEvent.selectOptions(await screen.findByLabelText(/saved searches/i), 's1')
    expect(onApply).toHaveBeenCalledWith({ platform: 'linkedin', minLikes: 500 })
  })

  it('saves the current filters under a name via POST', async () => {
    const cap: { body: { name?: string; params?: unknown } | null } = { body: null }
    server.use(
      http.get('*/api/saved-searches', () => HttpResponse.json({ searches: [] })),
      http.post('*/api/saved-searches', async ({ request }) => {
        cap.body = (await request.json()) as { name?: string; params?: unknown }
        return HttpResponse.json({ searches: [search({ name: 'My preset' })] })
      }),
    )
    render(<SavedSearches current={{ platform: 'twitter', minLikes: 10 }} onApply={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/preset name/i), 'My preset')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(cap.body).toEqual({ name: 'My preset', params: { platform: 'twitter', minLikes: 10 } })
  })
})
