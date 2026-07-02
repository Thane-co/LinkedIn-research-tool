// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ManualScrape } from '@/app/ManualScrape'
import { server } from '@/tests/msw/server'

afterEach(() => server.resetHandlers())

describe('ManualScrape', () => {
  it('runs a scrape and shows the completion pill', async () => {
    server.use(
      http.post('*/api/scrape', () => HttpResponse.json({ jobId: 'j1' }, { status: 202 })),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 5 })),
    )
    render(<ManualScrape coreCount={48} />)
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/complete/i)).toHaveTextContent(/5/)
  })

  it('surfaces a 412 as a settings prompt instead of starting a job', async () => {
    server.use(http.post('*/api/scrape', () => HttpResponse.json({ needs: ['voyage_api_key'] }, { status: 412 })))
    render(<ManualScrape />)
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/settings/i)).toBeInTheDocument()
  })

  it('summarizes the resolved run', () => {
    render(<ManualScrape coreCount={48} keywords={['ai', 'llm']} />)
    expect(screen.getByText(/48 core creators \+ 2 keywords/i)).toBeInTheDocument()
  })
})
