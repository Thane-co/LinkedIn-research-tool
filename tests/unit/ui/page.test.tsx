// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Page from '@/app/page'
import { server } from '@/tests/msw/server'

const settings = (ready: { apify: boolean; voyage: boolean }) => ({
  settings: { apify_api_token: ready.apify ? 'set' : 'unset', voyage_api_key: ready.voyage ? 'set' : 'unset' },
  ready: { ...ready, anthropic: false },
})

const emptyPosts = { posts: [], total: 0, page: 1, pageSize: 50, hasMore: false, availableAuthors: [] }

afterEach(() => server.resetHandlers())

describe('Page (readiness gate)', () => {
  it('opens the Scrape Settings screen (onboarding gate) when required keys are missing', async () => {
    server.use(
      http.get('*/api/settings', () => HttpResponse.json(settings({ apify: false, voyage: false }))),
      http.get('*/api/creators', () => HttpResponse.json({ creators: [], tags: [] })),
      http.get('*/api/keywords', () => HttpResponse.json({ groups: [] })),
      http.get('*/api/scrape/history', () => HttpResponse.json({ jobs: [] })),
    )
    render(<Page />)
    expect(await screen.findByTestId('settings-gate')).toBeInTheDocument()
    // Search is disabled until keys are set
    expect(screen.getByRole('button', { name: /^search$/i })).toBeDisabled()
  })

  it('opens the Search screen once Apify + Voyage are ready', async () => {
    server.use(
      http.get('*/api/settings', () => HttpResponse.json(settings({ apify: true, voyage: true }))),
      http.get('*/api/posts', () => HttpResponse.json(emptyPosts)),
      http.get('*/api/saved-searches', () => HttpResponse.json({ searches: [] })),
    )
    render(<Page />)
    expect(await screen.findByRole('heading', { name: /search posts/i })).toBeInTheDocument()
    expect(screen.queryByTestId('settings-gate')).not.toBeInTheDocument()
  })
})
