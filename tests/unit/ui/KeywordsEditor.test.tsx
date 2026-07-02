// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { KeywordsEditor } from '@/app/KeywordsEditor'
import { server } from '@/tests/msw/server'

const groups = (over?: unknown) =>
  over ?? [
    { market: 'ai', terms: [{ id: 'k1', market: 'ai', term: 'llm', created_at: 't' }] },
  ]

afterEach(() => server.resetHandlers())

describe('KeywordsEditor', () => {
  it('shows an error state when the keywords load fails', async () => {
    server.use(http.get('*/api/keywords', () => new HttpResponse(null, { status: 500 })))
    render(<KeywordsEditor />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load|failed|error/i)
  })

  it('loads and renders markets with their term chips', async () => {
    server.use(http.get('*/api/keywords', () => HttpResponse.json({ groups: groups() })))
    render(<KeywordsEditor />)
    expect(await screen.findByText('ai')).toBeInTheDocument()
    expect(screen.getByText('llm')).toBeInTheDocument()
  })

  it('adds a keyword to a market via POST', async () => {
    const cap: { body: { market?: string; term?: string } | null } = { body: null }
    server.use(
      http.get('*/api/keywords', () => HttpResponse.json({ groups: groups() })),
      http.post('*/api/keywords', async ({ request }) => {
        cap.body = (await request.json()) as { market?: string; term?: string }
        return HttpResponse.json({ groups: groups() })
      }),
    )
    render(<KeywordsEditor />)
    await userEvent.type(await screen.findByLabelText(/add keyword to ai/i), 'agents')
    await userEvent.click(screen.getByRole('button', { name: /add to ai/i }))
    expect(cap.body).toEqual({ market: 'ai', term: 'agents' })
  })

  it('removes a keyword via DELETE ?id', async () => {
    let url: string | null = null
    server.use(
      http.get('*/api/keywords', () => HttpResponse.json({ groups: groups() })),
      http.delete('*/api/keywords', ({ request }) => {
        url = request.url
        return HttpResponse.json({ groups: [] })
      }),
    )
    render(<KeywordsEditor />)
    await userEvent.click(await screen.findByRole('button', { name: /remove keyword llm/i }))
    expect(url).toContain('id=k1')
  })

  it('removes an entire market via DELETE ?market', async () => {
    let url: string | null = null
    server.use(
      http.get('*/api/keywords', () => HttpResponse.json({ groups: groups() })),
      http.delete('*/api/keywords', ({ request }) => {
        url = request.url
        return HttpResponse.json({ groups: [] })
      }),
    )
    render(<KeywordsEditor />)
    await userEvent.click(await screen.findByRole('button', { name: /remove market ai/i }))
    expect(url).toContain('market=ai')
  })

  it('adds a new (empty) market locally so keywords can be added to it', async () => {
    server.use(http.get('*/api/keywords', () => HttpResponse.json({ groups: [] })))
    render(<KeywordsEditor />)
    await userEvent.type(await screen.findByLabelText(/new market/i), 'solution engineer')
    await userEvent.click(screen.getByRole('button', { name: /add market/i }))
    expect(screen.getByText('solution engineer')).toBeInTheDocument()
  })
})
