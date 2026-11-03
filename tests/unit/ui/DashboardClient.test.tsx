// @vitest-environment jsdom
import { delay, http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(() => server.resetHandlers())

describe('DashboardClient', () => {
  it('shows an error banner (not a silent blank) when the posts request fails', async () => {
    server.use(http.get('*/api/posts', () => new HttpResponse(null, { status: 500 })))
    render(<DashboardClient />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load|failed|error/i)
  })

  it('never lets a slow, older search overwrite a newer one', async () => {
    let calls = 0
    server.use(
      http.get('*/api/posts', async () => {
        calls++
        if (calls === 1) {
          await delay(300) // the mount search is slow and resolves LAST
          return HttpResponse.json(postsResponse([post({ id: 'old', author_name: 'Stale Result' })], 1))
        }
        return HttpResponse.json(postsResponse([post({ id: 'new', author_name: 'Fresh Result' })], 2))
      }),
    )
    render(<DashboardClient />)
    await userEvent.click(screen.getByRole('button', { name: /substack/i })) // newer search
    expect(await screen.findByText('Fresh Result')).toBeInTheDocument()
    await delay(400) // let the stale mount response land
    expect(screen.queryByText('Stale Result')).not.toBeInTheDocument()
    expect(screen.getByText('Fresh Result')).toBeInTheDocument()
  })

  it('fetches posts on mount and shows the result count', async () => {
    server.use(http.get('*/api/posts', () => HttpResponse.json(postsResponse([post()], 24))))
    render(<DashboardClient />)
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText(/showing 1 of 24 matching posts/i)).toBeInTheDocument()
  })

  it('switches into image-group mode, shows the slider + score + the grouped posts', async () => {
    server.use(
      http.get('*/api/posts', ({ request }) => {
        const grouping = new URL(request.url).searchParams.get('groupByImage') === 'true'
        return grouping
          ? HttpResponse.json({
              posts: [post({ id: 'a', author_name: 'Member A' }), post({ id: 'b', author_name: 'Member B' })],
              hasMore: false,
              availableAuthors: [],
              imageGroups: [
                { postIds: ['a', 'b'], sharedDescription: 'a chart', similarity: 0.87, totalLikes: 5, totalShares: 1 },
              ],
            })
          : HttpResponse.json(postsResponse([post()]))
      }),
    )
    render(<DashboardClient />)
    await userEvent.click(await screen.findByRole('button', { name: /group by image/i }))
    expect(await screen.findByText('a chart')).toBeInTheDocument()
    expect(screen.getByText(/87% similar/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/image similarity threshold/i)).toBeInTheDocument()
    // the grouped member posts render (as full cards) under the panel
    expect(screen.getByText('Member A')).toBeInTheDocument()
    expect(screen.getByText('Member B')).toBeInTheDocument()
  })

  it('shows an empty-state (not a blank page) when no image groups form', async () => {
    server.use(
      http.get('*/api/posts', ({ request }) => {
        const grouping = new URL(request.url).searchParams.get('groupByImage') === 'true'
        return grouping
          ? HttpResponse.json({ posts: [], hasMore: false, availableAuthors: [], imageGroups: [] })
          : HttpResponse.json(postsResponse([post()]))
      }),
    )
    render(<DashboardClient />)
    await userEvent.click(await screen.findByRole('button', { name: /group by image/i }))
    expect(await screen.findByText(/no image groups/i)).toBeInTheDocument()
  })
})
