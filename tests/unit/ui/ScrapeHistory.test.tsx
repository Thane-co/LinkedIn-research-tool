// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScrapeHistory } from '@/app/ScrapeHistory'
import { server } from '@/tests/msw/server'

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  status: 'succeeded',
  mode: 'both',
  platforms: JSON.stringify(['linkedin', 'twitter']),
  params: JSON.stringify({ keywords: ['ai', 'llm'] }),
  keyword_raw: 300,
  creator_raw: 85,
  inserted: 380,
  started_at: '2026-06-19T13:38:00.000Z',
  ...over,
})

afterEach(() => server.resetHandlers())

describe('ScrapeHistory', () => {
  it('shows an error state (not the empty state) when the history load fails', async () => {
    server.use(http.get('*/api/scrape/history', () => new HttpResponse(null, { status: 500 })))
    render(<ScrapeHistory />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load|failed|error/i)
    expect(screen.queryByText(/no scrapes yet/i)).not.toBeInTheDocument()
  })

  it('renders a row per run with fetched (raw sum) and new (inserted) counts', async () => {
    server.use(http.get('*/api/scrape/history', () => HttpResponse.json({ jobs: [job()] })))
    render(<ScrapeHistory />)
    expect(await screen.findByText(/both/i)).toBeInTheDocument()
    expect(screen.getByText('385')).toBeInTheDocument() // fetched = 300 + 85
    expect(screen.getByText('380')).toBeInTheDocument() // new = inserted
    expect(screen.getByText(/ai, llm/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no runs', async () => {
    server.use(http.get('*/api/scrape/history', () => HttpResponse.json({ jobs: [] })))
    render(<ScrapeHistory />)
    expect(await screen.findByText(/no scrapes yet/i)).toBeInTheDocument()
  })
})
