// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardClient } from '@/app/DashboardClient'
import { server } from '@/tests/msw/server'

const post = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  platform: 'linkedin',
  url: 'https://li/p1',
  content: 'hello world',
  author_name: 'Jane Doe',
  author_id: 'jane',
  posted_at: '2026-06-26T00:00:00.000Z',
  likes: 10,
  comments: 1,
  shares: 0,
  x_factor: null,
  scrape_source: 'keyword',
  image_url: null,
  ...over,
})

const postsResponse = (posts: unknown[], total = posts.length) => ({
  posts,
  total,
  page: 1,
  pageSize: 50,
  hasMore: false,
  availableAuthors: [],
})

beforeEach(() => {
  // DashboardClient embeds SavedSearches, which loads presets on mount.
  server.use(http.get('*/api/saved-searches', () => HttpResponse.json({ searches: [] })))
})
afterEach(() => server.resetHandlers())

describe('DashboardClient', () => {
  it('fetches posts on mount and shows the result count', async () => {
    server.use(http.get('*/api/posts', () => HttpResponse.json(postsResponse([post()], 24))))
    render(<DashboardClient />)
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText(/showing 1 of 24 matching posts/i)).toBeInTheDocument()
  })

  it('switches into image-group mode from the header button', async () => {
    server.use(
      http.get('*/api/posts', ({ request }) => {
        const grouping = new URL(request.url).searchParams.get('groupByImage') === 'true'
        return grouping
          ? HttpResponse.json({
              posts: [],
              hasMore: false,
              availableAuthors: [],
              imageGroups: [{ postIds: ['a', 'b'], sharedDescription: 'a chart', totalLikes: 5, totalShares: 1 }],
            })
          : HttpResponse.json(postsResponse([post()]))
      }),
    )
    render(<DashboardClient />)
    await userEvent.click(await screen.findByRole('button', { name: /group by image/i }))
    expect(await screen.findByText('a chart')).toBeInTheDocument()
  })
})
