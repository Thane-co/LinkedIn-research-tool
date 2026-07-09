// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PostCard, type PostCardPost } from '@/app/PostCard'

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

})
