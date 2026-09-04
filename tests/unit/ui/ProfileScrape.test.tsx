// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProfileScrape } from '@/app/ProfileScrape'
import { server } from '@/tests/msw/server'

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'basiakubicka',
  url: 'https://www.linkedin.com/in/basiakubicka/',
  name: 'Basia Kubicka',
  headline: 'AI PM',
  about: null,
  followers: 69000,
  connections: 500,
  location: null,
  avatar_url: null,
  experience: null,
  education: null,
  skills: null,
  scraped_at: '2026-07-20T10:00:00.000Z',
  raw_data: null,
  ...over,
})

// By default the panel self-loads its stored profiles on mount (empty).
beforeEach(() => {
  server.use(http.get('*/api/profile', () => HttpResponse.json({ profiles: [] })))
})
afterEach(() => server.resetHandlers())

describe('ProfileScrape', () => {
  it('lists stored profiles loaded on mount, with the follower count', async () => {
    server.use(http.get('*/api/profile', () => HttpResponse.json({ profiles: [profile()] })))
    render(<ProfileScrape />)
    expect(await screen.findByText('Basia Kubicka')).toBeInTheDocument()
    expect(screen.getByText(/69,000 followers/)).toBeInTheDocument()
    expect(screen.getByText(/500 connections/)).toBeInTheDocument()
  })

  it('scrapes a profile: posts the query, shows the success pill, refreshes the list', async () => {
    let body: { query?: string } | null = null
    let getCalls = 0
    server.use(
      http.get('*/api/profile', () => {
        getCalls += 1
        // empty on mount, then the freshly-scraped profile after the POST
        return HttpResponse.json({ profiles: getCalls > 1 ? [profile()] : [] })
      }),
      http.post('*/api/profile', async ({ request }) => {
        body = (await request.json()) as { query?: string }
        return HttpResponse.json({ profile: profile() })
      }),
    )
    render(<ProfileScrape />)
    await userEvent.type(screen.getByLabelText(/profile url or handle/i), 'basiakubicka')
    await userEvent.click(screen.getByRole('button', { name: /scrape profile/i }))
    expect(await screen.findByText(/profile scraped/i)).toBeInTheDocument()
    expect(body!.query).toBe('basiakubicka')
    expect(await screen.findByText('Basia Kubicka')).toBeInTheDocument() // list refreshed
  })

  it('surfaces a 412 as a settings prompt instead of a failure', async () => {
    server.use(http.post('*/api/profile', () => HttpResponse.json({ needs: ['apify_api_token'] }, { status: 412 })))
    render(<ProfileScrape />)
    await userEvent.type(screen.getByLabelText(/profile url or handle/i), 'basiakubicka')
    await userEvent.click(screen.getByRole('button', { name: /scrape profile/i }))
    expect(await screen.findByText(/add apify_api_token in settings/i)).toBeInTheDocument()
  })

  it('marks the pill failed when the scrape errors (non-412)', async () => {
    server.use(http.post('*/api/profile', () => HttpResponse.json({ error: 'no profile' }, { status: 502 })))
    render(<ProfileScrape />)
    await userEvent.type(screen.getByLabelText(/profile url or handle/i), 'ghost')
    await userEvent.click(screen.getByRole('button', { name: /scrape profile/i }))
    expect(await screen.findByText(/scrape failed/i)).toBeInTheDocument()
  })

  it('disables the button until a query is entered', async () => {
    render(<ProfileScrape />)
    expect(screen.getByRole('button', { name: /scrape profile/i })).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/profile url or handle/i), 'x')
    expect(screen.getByRole('button', { name: /scrape profile/i })).toBeEnabled()
  })
})
