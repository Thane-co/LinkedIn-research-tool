// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
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
  tags: '[]',
  ...over,
})

afterEach(() => server.resetHandlers())

describe('CreatorManager', () => {
  it('shows an error state (not a silent blank) when the creators load fails', async () => {
    server.use(http.get('*/api/creators', () => new HttpResponse(null, { status: 500 })))
    render(<CreatorManager />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load|failed|error/i)
  })

  it('loads and renders the creator list on mount', async () => {
    server.use(http.get('*/api/creators', () => HttpResponse.json({ creators: [creator()], tags: [] })))
    render(<CreatorManager />)
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
  })

  it('shows the persona label on a creator row (§17.2)', async () => {
    server.use(
      http.get('*/api/creators', () =>
        HttpResponse.json({ creators: [creator({ persona: 'lara acosta', platform: 'substack' })], tags: [] }),
      ),
    )
    render(<CreatorManager />)
    expect(await screen.findByText(/lara acosta/i)).toBeInTheDocument()
  })

  it('sends an explicit persona when the Person field is filled (§17.2)', async () => {
    const cap: { body: { persona?: string } | null } = { body: null }
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: [], tags: [] })),
      http.post('*/api/creators', async ({ request }) => {
        cap.body = (await request.json()) as { persona?: string }
        return HttpResponse.json({ creators: [], tags: [] })
      }),
    )
    render(<CreatorManager />)
    await userEvent.type(screen.getByLabelText(/profile url/i), 'https://lara.substack.com')
    await userEvent.type(screen.getByLabelText(/^person$/i), 'Lara Acosta')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(cap.body).toMatchObject({ persona: 'Lara Acosta' })
  })

  it('adds a creator via POST with the profile input', async () => {
    const cap: { body: { inputs?: string[] } | null } = { body: null }
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: [], tags: [] })),
      http.post('*/api/creators', async ({ request }) => {
        cap.body = (await request.json()) as { inputs?: string[] }
        return HttpResponse.json({ creators: [], tags: [] })
      }),
    )
    render(<CreatorManager />)
    await userEvent.type(screen.getByLabelText(/profile url/i), '@janedev')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(cap.body).toMatchObject({ inputs: ['@janedev'] })
  })

  it('imports creators from an uploaded CSV (parsed client-side into inputs)', async () => {
    const cap: { body: { inputs?: string[] } | null } = { body: null }
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: [], tags: [] })),
      http.post('*/api/creators', async ({ request }) => {
        cap.body = (await request.json()) as { inputs?: string[] }
        return HttpResponse.json({ creators: [], tags: [] })
      }),
    )
    render(<CreatorManager />)
    const csv = 'profile_url\nhttps://www.linkedin.com/in/jane\n@janedev'
    const file = new File([csv], 'creators.csv', { type: 'text/csv' })
    await userEvent.upload(screen.getByLabelText(/upload csv/i), file)
    await waitFor(() =>
      expect(cap.body).toEqual({ inputs: ['https://www.linkedin.com/in/jane', '@janedev'] }),
    )
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

describe('CreatorManager — person x platform table (PRD §11.8)', () => {
  const rows = [
    creator({ id: 'c1', platform: 'linkedin', display_name: 'Jane Doe', persona: 'jane doe' }),
    creator({
      id: 'c2',
      platform: 'twitter',
      display_name: 'Jane Doe',
      persona: 'jane doe',
      author_id: 'janedev',
      profile_url: 'https://x.com/janedev',
    }),
    creator({
      id: 'c3',
      platform: 'substack',
      display_name: 'Ada L',
      persona: 'ada l',
      profile_url: 'https://ada.substack.com',
    }),
  ]

  it('counts accounts per platform in the header', async () => {
    server.use(http.get('*/api/creators', () => HttpResponse.json({ creators: rows, tags: [] })))
    render(<CreatorManager />)
    expect(await screen.findByText(/1 LinkedIn/)).toBeInTheDocument()
    expect(screen.getByText(/1 X\b/)).toBeInTheDocument()
    expect(screen.getByText(/0 Instagram/)).toBeInTheDocument()
  })

  it('puts one person on one row across platforms', async () => {
    server.use(http.get('*/api/creators', () => HttpResponse.json({ creators: rows, tags: [] })))
    render(<CreatorManager />)
    // 3 accounts, 2 people -> 2 body rows
    await screen.findByText('Jane Doe')
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2 people
  })

  it('offers an add button on each platform a person is missing', async () => {
    server.use(http.get('*/api/creators', () => HttpResponse.json({ creators: rows, tags: [] })))
    render(<CreatorManager />)
    expect(await screen.findByRole('button', { name: /add substack for jane doe/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add linkedin for jane doe/i })).toBeNull()
  })

  it('prefills the Person field when an add cell is clicked, so the account links up', async () => {
    server.use(http.get('*/api/creators', () => HttpResponse.json({ creators: rows, tags: [] })))
    render(<CreatorManager />)
    await userEvent.click(await screen.findByRole('button', { name: /add substack for jane doe/i }))
    expect(screen.getByLabelText(/^person$/i)).toHaveValue('jane doe')
  })

  it('links accounts by name via the backfill endpoint', async () => {
    let called = false
    server.use(
      http.get('*/api/creators', () => HttpResponse.json({ creators: rows, tags: [] })),
      http.post('*/api/creators/backfill-personas', () => {
        called = true
        return HttpResponse.json({ updated: 2, creators: rows, tags: [] })
      }),
    )
    render(<CreatorManager />)
    await userEvent.click(await screen.findByRole('button', { name: /link accounts by name/i }))
    await waitFor(() => expect(called).toBe(true))
    expect(await screen.findByText(/linked 2/i)).toBeInTheDocument()
  })
})
