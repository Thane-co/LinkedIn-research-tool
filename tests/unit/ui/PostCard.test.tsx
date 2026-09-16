// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { PostCard, type PostCardPost } from '@/app/PostCard'
import { server } from '@/tests/msw/server'

const makePost = (over: Partial<PostCardPost> = {}): PostCardPost => ({
  id: 'p1',
  platform: 'linkedin',
  url: 'https://li/p1',
  content: 'A short post',
  author_name: 'Jane Doe',
  posted_at: '2026-06-26T00:00:00.000Z',
  likes: 120,
  comments: 8,
  shares: 3,
  x_factor: 3,
  scrape_source: 'both',
  image_url: null,
  media: null,
  ...over,
})

describe('PostCard — comments on her own posts (§23)', () => {
  const OWN = 'basiakubicka'
  const own = (over: Partial<PostCardPost> = {}): PostCardPost =>
    makePost({ id: '100', author_id: OWN, comments: 3, ...over })
  const stored = {
    post_id: '100',
    total_on_linkedin: 3,
    comments: [
      { id: 'a', parent_comment_id: null, author_name: 'Jane Doe', author_headline: 'Founder', is_post_author: 0, text: 'Step 3 assumes a lot', likes: 2, commented_at: '2026-09-14T09:00:00.000Z' },
      { id: 'r', parent_comment_id: 'a', author_name: 'Basia Kubicka', author_headline: null, is_post_author: 1, text: 'Fair point', likes: 0, commented_at: '2026-09-14T10:00:00.000Z' },
    ],
  }

  it("shows no comments section on someone else's post, or when her author id is not set", () => {
    const { rerender } = render(<PostCard post={makePost({ author_id: 'jane' })} ownAuthorId={OWN} />)
    expect(screen.queryByTestId('comments')).not.toBeInTheDocument()
    rerender(<PostCard post={own()} />)
    expect(screen.queryByTestId('comments')).not.toBeInTheDocument()
  })

  it('loads the stored comments on demand, with replies nested under the comment they answer', async () => {
    server.use(http.get('*/api/posts/100/comments', () => HttpResponse.json(stored)))
    render(<PostCard post={own()} ownAuthorId={OWN} />)

    await userEvent.click(screen.getByRole('button', { name: /show comments/i }))

    const reply = await screen.findByText('Fair point')
    expect(screen.getByText('Step 3 assumes a lot')).toBeInTheDocument()
    expect(reply.closest('[data-reply="true"]')).not.toBeNull()
    expect(screen.getByTestId('comments')).toHaveTextContent(/2 of 3 stored/i)
  })

  it('fetches fresh comments from LinkedIn for this post only, then shows them', async () => {
    let scrapeBody: unknown = null
    server.use(
      http.get('*/api/posts/100/comments', () => HttpResponse.json(stored)),
      http.post('*/api/comments/scrape', async ({ request }) => {
        scrapeBody = await request.json()
        return HttpResponse.json({ stored: 2, cost_usd: 0.004, errors: [] })
      }),
    )
    render(<PostCard post={own()} ownAuthorId={OWN} />)

    await userEvent.click(screen.getByRole('button', { name: /fetch comments/i }))

    expect(await screen.findByText('Fair point')).toBeInTheDocument()
    expect(scrapeBody).toEqual({ postIds: ['100'], force: true })
  })

  it('surfaces a failed fetch instead of showing an empty list', async () => {
    server.use(http.post('*/api/comments/scrape', () => HttpResponse.json({ error: 'actor 500' }, { status: 502 })))
    render(<PostCard post={own()} ownAuthorId={OWN} />)

    await userEvent.click(screen.getByRole('button', { name: /fetch comments/i }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('PostCard', () => {
  it('renders author, posted date, engagement, platform + scrape-source badges', () => {
    render(<PostCard post={makePost()} />)
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Jun 26, 2026')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.getByText(/linkedin/i)).toBeInTheDocument()
    expect(screen.getByText(/both/i)).toBeInTheDocument()
  })

  it('renders the Substack platform badge for a Substack post (§17.1)', () => {
    render(<PostCard post={makePost({ platform: 'substack' })} />)
    expect(screen.getByText(/substack/i)).toBeInTheDocument()
  })

  it('links to the original post (new tab) and has no selection checkbox', () => {
    render(<PostCard post={makePost({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:99/' })} />)
    const link = screen.getByRole('link', { name: /open the original post/i })
    expect(link).toHaveAttribute('href', 'https://www.linkedin.com/feed/update/urn:li:activity:99/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add .* to creators/i })).not.toBeInTheDocument()
  })

  it('does not render an unsafe (javascript:) post url as a link', () => {
    render(<PostCard post={makePost({ url: 'javascript:alert(1)' })} />)
    expect(screen.queryByRole('link', { name: /open the original post/i })).not.toBeInTheDocument()
  })

  it('shows a green 🔥 x-factor badge for a viral post and hides it when null', () => {
    const { rerender } = render(<PostCard post={makePost({ x_factor: 3 })} />)
    const badge = screen.getByTestId('xfactor-badge')
    expect(badge).toHaveAttribute('data-tone', 'green')
    expect(badge).toHaveTextContent('3.0×')

    rerender(<PostCard post={makePost({ x_factor: null })} />)
    expect(screen.queryByTestId('xfactor-badge')).not.toBeInTheDocument()
  })

  it('truncates long content and expands on demand', async () => {
    const long = 'x'.repeat(400)
    render(<PostCard post={makePost({ content: long })} />)
    expect(screen.queryByText(long)).not.toBeInTheDocument() // truncated
    await userEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('renders a single image', () => {
    render(<PostCard post={makePost({ media: { type: 'image', images: ['https://img/only.png'] } })} />)
    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]).toHaveAttribute('src', 'https://img/only.png')
  })

  it('renders a carousel (all images) with a count', () => {
    render(<PostCard post={makePost({ media: { type: 'image', images: ['a', 'b', 'c'] } })} />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.getByText(/3 images/i)).toBeInTheDocument()
  })

  it('renders a video as a poster + play affordance linking to the original post', () => {
    render(
      <PostCard
        post={makePost({ url: 'https://li/post', media: { type: 'video', url: 'https://vid/stream', poster: 'https://vid/poster.jpg' } })}
      />,
    )
    const video = screen.getByTestId('video-media')
    expect(video).toHaveAttribute('href', 'https://li/post') // opens the post, not the raw stream
    expect(video.querySelector('img')).toHaveAttribute('src', 'https://vid/poster.jpg')
  })

  it('renders a document as a cover + page-count badge linking to the document', () => {
    render(
      <PostCard
        post={makePost({
          media: { type: 'document', url: 'https://doc/pdf', title: 'Deck', pages: 12, cover: 'https://doc/cover.png' },
        })}
      />,
    )
    const doc = screen.getByTestId('document-media')
    expect(doc).toHaveAttribute('href', 'https://doc/pdf')
    expect(screen.getByText(/12 pages/i)).toBeInTheDocument()
    expect(doc.querySelector('img')).toHaveAttribute('src', 'https://doc/cover.png')
  })

  it('falls back to image_url when no structured media is present', () => {
    render(<PostCard post={makePost({ media: null, image_url: 'https://img/fallback.png' })} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://img/fallback.png')
  })

  it('shows a video transcript under the caption with a divider, only when present (§18)', () => {
    const { rerender } = render(<PostCard post={makePost({ content: 'my caption', transcript: null })} />)
    expect(screen.queryByTestId('transcript')).not.toBeInTheDocument()

    rerender(<PostCard post={makePost({ content: 'my caption', transcript: 'the spoken words of the reel' })} />)
    const block = screen.getByTestId('transcript')
    expect(block).toHaveTextContent(/video transcript/i)
    expect(block).toHaveTextContent('the spoken words of the reel')
  })

  it('routes an Instagram CDN video poster through the same-origin media proxy (§18)', () => {
    const poster = 'https://scontent-lga3-1.cdninstagram.com/v/poster.jpg?a=1'
    render(
      <PostCard
        post={makePost({ platform: 'instagram', url: 'https://www.instagram.com/p/X/', media: { type: 'video', url: 'https://ig/stream', poster } })}
      />,
    )
    expect(screen.getByTestId('video-media').querySelector('img')).toHaveAttribute(
      'src',
      `/api/media?url=${encodeURIComponent(poster)}`,
    )
  })

})

// An expired signed url is a permanent 403 (§10.3.2). Rendering it produces a broken-image icon AND
// a doomed round trip through /api/media. 37k+ posts in the corpus are in that state.
describe('PostCard — unavailable media', () => {
  const EXPIRED = 'https://media.licdn.com/dms/image/v2/x/feedshare/0/1?e=1000000001&v=beta&t=z'
  const LIVE = 'https://media.licdn.com/dms/image/v2/x/feedshare/0/1?e=4102444799&v=beta&t=z'

  it('shows a placeholder instead of requesting an image whose signature has expired', () => {
    render(<PostCard post={makePost({ media: null, image_url: EXPIRED })} />)
    expect(screen.getByLabelText(/no longer available/i)).toBeInTheDocument()
    // The point is that no <img> is emitted at all — no request, no broken icon.
    expect(document.querySelector('img')).toBeNull()
  })

  it('still renders an image whose signature is not yet expired', () => {
    render(<PostCard post={makePost({ media: null, image_url: LIVE })} />)
    expect(document.querySelector('img')).toHaveAttribute('src', `/api/media?url=${encodeURIComponent(LIVE)}`)
    expect(screen.queryByLabelText(/no longer available/i)).not.toBeInTheDocument()
  })

  it('falls back to the placeholder when a load fails for a reason the url cannot reveal', () => {
    // Unsigned urls, deleted local files, a dead host: nothing to predict offline, so the img's own
    // onError has to catch it.
    render(<PostCard post={makePost({ media: null, image_url: 'https://substackcdn.com/gone.jpg' })} />)
    const img = document.querySelector('img')!
    expect(img).toBeInTheDocument()
    fireEvent.error(img)
    expect(screen.getByLabelText(/no longer available/i)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('marks each carousel image independently, so one dead image does not blank the rest', () => {
    render(
      <PostCard post={makePost({ media: { type: 'image', images: [EXPIRED, LIVE, EXPIRED] } })} />,
    )
    expect(screen.getAllByLabelText(/no longer available/i)).toHaveLength(2)
    expect(document.querySelectorAll('img')).toHaveLength(1)
  })

  it('keeps the video link and play affordance when only the poster has expired', () => {
    render(
      <PostCard post={makePost({ media: { type: 'video', url: 'https://vid/1', poster: EXPIRED } })} />,
    )
    const video = screen.getByTestId('video-media')
    expect(video).toHaveAttribute('href', 'https://li/p1') // still opens the post
    expect(video.querySelector('img')).toBeNull()
    expect(screen.getByLabelText(/no longer available/i)).toBeInTheDocument()
  })

  it('renders a locally-cached image path as-is (those are not signed and do not expire)', () => {
    render(<PostCard post={makePost({ media: null, image_url: '/post-images/posts/7219377413342806018.jpg' })} />)
    expect(document.querySelector('img')).toHaveAttribute('src', '/post-images/posts/7219377413342806018.jpg')
  })
})
