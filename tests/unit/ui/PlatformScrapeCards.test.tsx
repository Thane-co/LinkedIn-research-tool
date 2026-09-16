// @vitest-environment jsdom
// Layer 5 — one scrape card per platform (PRD §11.8). Each card runs its own platform, on its own
// terms, and remembers them.
import { http, HttpResponse } from 'msw'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformScrapeCards } from '@/app/PlatformScrapeCards'
import { server } from '@/tests/msw/server'

const STATUS = {
  platforms: {
    linkedin: { lastScrapedAt: '2026-09-04T12:00:00.000Z', creators: 112 },
    twitter: { lastScrapedAt: '2026-09-04T12:00:00.000Z', creators: 0 },
    substack: { lastScrapedAt: null, creators: 4 },
    instagram: { lastScrapedAt: '2026-08-01T12:00:00.000Z', creators: 2 },
  },
}

let savedSettings: Record<string, string> | null = null

beforeEach(() => {
  vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'))
  savedSettings = null
  server.use(
    http.get('*/api/scrape/status', () => HttpResponse.json(STATUS)),
    http.get('*/api/keywords', () =>
      HttpResponse.json({ groups: [{ market: 'ai', terms: [{ term: 'llm' }, { term: 'agents' }] }] }),
    ),
    http.get('*/api/settings', () => HttpResponse.json({ settings: {}, ready: { apify: true, voyage: true } })),
    http.put('*/api/settings', async ({ request }) => {
      savedSettings = (await request.json()) as Record<string, string>
      return HttpResponse.json({ settings: savedSettings, ready: { apify: true, voyage: true } })
    }),
  )
})
afterEach(() => {
  server.resetHandlers()
  vi.useRealTimers()
})

const card = async (name: RegExp): Promise<HTMLElement> =>
  (await screen.findByRole('group', { name })) as HTMLElement

describe('PlatformScrapeCards', () => {
  it('renders one card per platform', async () => {
    render(<PlatformScrapeCards />)
    expect(await screen.findByRole('group', { name: /linkedin/i })).toBeInTheDocument()
    expect(await card(/^x \/ twitter/i)).toBeInTheDocument()
    expect(await card(/substack/i)).toBeInTheDocument()
    expect(await card(/instagram/i)).toBeInTheDocument()
  })

  it('shows when each platform was last scraped, and never when it has no posts', async () => {
    render(<PlatformScrapeCards />)
    // The cards render first and the status arrives async, so wait for the loaded value.
    expect(await within(await card(/linkedin/i)).findByText(/3 days ago/i)).toBeInTheDocument()
    expect(await within(await card(/substack/i)).findByText(/never/i)).toBeInTheDocument()
    expect(await within(await card(/instagram/i)).findByText(/1 month ago/i)).toBeInTheDocument()
  })

  it('shows each platform its own creator count', async () => {
    render(<PlatformScrapeCards />)
    expect(await within(await card(/linkedin/i)).findByLabelText(/creators \(112\)/i)).toBeInTheDocument()
    expect(await within(await card(/^x \/ twitter/i)).findByLabelText(/creators \(0\)/i)).toBeInTheDocument()
  })

  it('posts only its own platform when a card is run', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 7 })),
    )
    render(<PlatformScrapeCards />)
    await userEvent.click(within(await card(/substack/i)).getByRole('button', { name: /run substack/i }))
    expect(await screen.findByText(/7 new/i)).toBeInTheDocument()
    expect(body!.platforms).toEqual(['substack'])
  })

  it('sends the Twitter likes floor with a Twitter run', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 1 })),
    )
    render(<PlatformScrapeCards />)
    await userEvent.click(within(await card(/^x \/ twitter/i)).getByRole('button', { name: /run x/i }))
    expect(await screen.findByText(/1 new/i)).toBeInTheDocument()
    expect(body!.minimumFavorites).toBe(250)
  })

  it('offers no likes floor on non-Twitter cards', async () => {
    render(<PlatformScrapeCards />)
    expect(within(await card(/^x \/ twitter/i)).getByLabelText(/min likes/i)).toBeInTheDocument()
    expect(within(await card(/linkedin/i)).queryByLabelText(/min likes/i)).toBeNull()
  })

  it('offers no keyword toggle on Instagram — its actor is profile-only', async () => {
    render(<PlatformScrapeCards />)
    expect(within(await card(/instagram/i)).queryByLabelText(/keywords/i)).toBeNull()
    expect(within(await card(/linkedin/i)).getByLabelText(/keywords/i)).toBeInTheDocument()
  })

  it('offers the Notes toggle only on Substack', async () => {
    render(<PlatformScrapeCards />)
    expect(within(await card(/substack/i)).getByLabelText(/notes/i)).toBeInTheDocument()
    expect(within(await card(/linkedin/i)).queryByLabelText(/notes/i)).toBeNull()
  })

  it('remembers a changed setting by saving scrape_prefs', async () => {
    render(<PlatformScrapeCards />)
    await userEvent.selectOptions(within(await card(/linkedin/i)).getByLabelText(/time frame/i), 'month')
    await vi.waitFor(() => expect(savedSettings).not.toBeNull())
    expect(JSON.parse(savedSettings!.scrape_prefs!).linkedin.timeframe).toBe('month')
  })

  it('restores saved prefs on load instead of the defaults', async () => {
    server.use(
      http.get('*/api/settings', () =>
        HttpResponse.json({
          settings: { scrape_prefs: JSON.stringify({ twitter: { minimumFavorites: 900, timeframe: 'month' } }) },
          ready: { apify: true, voyage: true },
        }),
      ),
    )
    render(<PlatformScrapeCards />)
    expect(await within(await card(/^x \/ twitter/i)).findByLabelText(/min likes/i)).toHaveValue(900)
  })

  it('derives the mode from the two source toggles', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('*/api/scrape', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ jobId: 'j1' }, { status: 202 })
      }),
      http.get('*/api/scrape/j1', () => HttpResponse.json({ id: 'j1', status: 'succeeded', inserted: 0 })),
    )
    render(<PlatformScrapeCards />)
    const li = await card(/linkedin/i)
    await userEvent.click(within(li).getByLabelText(/keywords/i)) // turn keywords off -> creators only
    await userEvent.click(within(li).getByRole('button', { name: /run linkedin/i }))
    await screen.findByText(/complete/i)
    expect(body!.mode).toBe('creator')
  })

  it('disables the run button when neither source is selected', async () => {
    render(<PlatformScrapeCards />)
    const li = await card(/linkedin/i)
    await userEvent.click(within(li).getByLabelText(/creators/i))
    await userEvent.click(within(li).getByLabelText(/keywords/i))
    expect(within(li).getByRole('button', { name: /run linkedin/i })).toBeDisabled()
  })

  it('surfaces the missing keys when the scrape is blocked with a 412', async () => {
    server.use(
      http.post('*/api/scrape', () => HttpResponse.json({ needs: ['apify_api_token'] }, { status: 412 })),
    )
    render(<PlatformScrapeCards />)
    await userEvent.click(within(await card(/linkedin/i)).getByRole('button', { name: /run linkedin/i }))
    expect(await screen.findByText(/apify_api_token/)).toBeInTheDocument()
  })

  it('shows an error state when the status load fails, never a silent blank', async () => {
    server.use(http.get('*/api/scrape/status', () => new HttpResponse(null, { status: 500 })))
    render(<PlatformScrapeCards />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
