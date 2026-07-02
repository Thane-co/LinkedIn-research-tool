// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ManualScrape } from '@/app/ManualScrape'
import { server } from '@/tests/msw/server'

// ManualScrape self-loads creators (core count) + keywords on mount; mock both by default.
beforeEach(() => {
  server.use(
    http.get('*/api/creators', () => HttpResponse.json({ creators: [{ id: 'a' }, { id: 'b' }], tags: [] })),
    http.get('*/api/keywords', () =>
      HttpResponse.json({ groups: [{ market: 'ai', terms: [{ term: 'llm' }, { term: 'agents' }] }] }),
    ),
  )
})
afterEach(() => server.resetHandlers())

describe('ManualScrape', () => {
  it('marks the pill failed when the scrape request errors (non-412)', async () => {
    server.use(http.post('*/api/scrape', () => new HttpResponse(null, { status: 500 })))
    render(<ManualScrape />)
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/scrape failed/i)).toBeInTheDocument()
  })

  it('runs a scrape and shows the completion pill', async () => {
    server.use(
      http.post('*/api/scrape', () => HttpResponse.json({ jobId: 'j1' }, { status: 202 })),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 5 })),
    )
    render(<ManualScrape />)
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/complete/i)).toHaveTextContent(/5/)
  })

  it('surfaces a 412 as a settings prompt instead of starting a job', async () => {
    server.use(http.post('*/api/scrape', () => HttpResponse.json({ needs: ['voyage_api_key'] }, { status: 412 })))
    render(<ManualScrape />)
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/settings/i)).toBeInTheDocument()
  })

  it('summarizes the resolved run from live creator count + market keywords', async () => {
    render(<ManualScrape />)
    // 2 creators (from mock) + 2 keywords in the 'ai' market (default: all markets)
    expect(await screen.findByText(/2 creators \+ 2 keywords/i)).toBeInTheDocument()
  })
})
