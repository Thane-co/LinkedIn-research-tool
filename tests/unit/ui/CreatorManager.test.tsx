// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { CreatorManager } from '@/app/CreatorManager'
import { server } from '@/tests/msw/server'

const creator = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  platform: 'linkedin',
  profile_url: 'https://www.linkedin.com/in/jane',
  author_id: 'jane',
  display_name: 'Jane Doe',
  tier: 'core',
  tags: '[]',
  ...over,
})

afterEach(() => server.resetHandlers())

describe('CreatorManager', () => {
  it('loads and renders the core creator list on mount', async () => {
    server.use(http.get('*/api/creators', () => HttpResponse.json({ creators: [creator()], tags: [] })))
    render(<CreatorManager />)
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
  })

  it('adds a creator via POST with the profile input + selected tier', async () => {
    const cap: { body: { inputs?: string[]; tier?: string } | null } = { body: null }
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: [], tags: [] })),
      http.post('*/api/creators', async ({ request }) => {
        cap.body = (await request.json()) as { inputs?: string[]; tier?: string }
        return HttpResponse.json({ creators: [], tags: [] })
      }),
    )
    render(<CreatorManager />)
    await userEvent.type(screen.getByLabelText(/profile url/i), '@janedev')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(cap.body).toMatchObject({ inputs: ['@janedev'], tier: 'core' })
  })

  it('demotes a core creator via PATCH', async () => {
    const cap: { body: { id?: string; tier?: string } | null } = { body: null }
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: [creator()], tags: [] })),
      http.patch('*/api/creators', async ({ request }) => {
        cap.body = (await request.json()) as { id?: string; tier?: string }
        return HttpResponse.json({ creators: [], tags: [] })
      }),
    )
    render(<CreatorManager />)
    await userEvent.click(await screen.findByRole('button', { name: /^demote$/i }))
    expect(cap.body).toEqual({ id: 'c1', tier: 'watch' })
  })

  it('deletes a creator via DELETE with its id', async () => {
    let deletedId: string | null = null
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: [creator()], tags: [] })),
      http.delete('*/api/creators', ({ request }) => {
        deletedId = new URL(request.url).searchParams.get('id')
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<CreatorManager />)
    await userEvent.click(await screen.findByRole('button', { name: /remove jane/i }))
    expect(deletedId).toBe('c1')
  })
})
