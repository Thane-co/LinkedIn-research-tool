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
    http.get('*/api/creators', () =>
      HttpResponse.json({ creators: [{ id: 'a', platform: 'linkedin' }, { id: 'b', platform: 'substack' }], tags: [] }),
    ),
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

  it('can scrape Substack only (§17): posts platforms:["substack"]', async () => {
    let body: { platforms?: string[] } | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as { platforms?: string[] }
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 0 })),
    )
    render(<ManualScrape />)
    await userEvent.selectOptions(screen.getByLabelText(/platform/i), 'substack')
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/complete/i)).toBeInTheDocument()
    expect(body!.platforms).toEqual(['substack'])
  })

  it('can scrape Instagram only (§18): posts platforms:["instagram"]', async () => {
    let body: { platforms?: string[] } | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as { platforms?: string[] }
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 0 })),
    )
    render(<ManualScrape />)
    await userEvent.selectOptions(screen.getByLabelText(/platform/i), 'instagram')
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    expect(await screen.findByText(/complete/i)).toBeInTheDocument()
    expect(body!.platforms).toEqual(['instagram'])
  })

  it('Substack Notes are opt-in: the toggle appears for Substack and sends includeNotes', async () => {
    let body: { includeNotes?: boolean } | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as { includeNotes?: boolean }
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 0 })),
    )
    render(<ManualScrape />)
    await userEvent.selectOptions(await screen.findByLabelText(/platform/i), 'substack')
    const toggle = screen.getByLabelText(/include substack notes/i)
    expect(toggle).not.toBeChecked() // off by default (faster)
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    await screen.findByText(/complete/i)
    expect(body!.includeNotes).toBe(true)
  })

  it('hides the Notes toggle when the platform is not Substack', async () => {
    render(<ManualScrape />)
    await userEvent.selectOptions(await screen.findByLabelText(/platform/i), 'twitter')
    expect(screen.queryByLabelText(/include substack notes/i)).not.toBeInTheDocument()
  })

  it('a Creators-only run sends no keywords (so history doesn’t show them)', async () => {
    let body: { mode?: string; keywords?: string[] } | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as { mode?: string; keywords?: string[] }
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 0 })),
    )
    render(<ManualScrape />)
    await userEvent.selectOptions(await screen.findByLabelText(/source/i), 'creator')
    await userEvent.click(screen.getByRole('button', { name: /run scrape now/i }))
    await screen.findByText(/complete/i)
    expect(body!.mode).toBe('creator')
    expect(body!.keywords).toEqual([]) // keywords omitted for a creators-only run
  })

  it('creator count reflects the selected platform (only Substack profiles for a Substack run)', async () => {
    render(<ManualScrape />)
    expect(await screen.findByText(/2 creators \+ 2 keywords/i)).toBeInTheDocument() // all platforms
    await userEvent.selectOptions(screen.getByLabelText(/platform/i), 'substack')
    expect(screen.getByText(/1 creators \+ 2 keywords/i)).toBeInTheDocument() // only the 1 substack profile
  })

  it('the summary reflects the source: Creators-only shows creators, not keywords', async () => {
    render(<ManualScrape />)
    // default 'both' shows both
    expect(await screen.findByText(/2 creators \+ 2 keywords/i)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText(/source/i), 'creator')
    expect(screen.getByText(/2 creators ·/i)).toBeInTheDocument()
    expect(screen.queryByText(/keywords ·/i)).not.toBeInTheDocument()
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
