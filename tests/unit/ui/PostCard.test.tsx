// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

  it('invokes add-to-creators from the ＋ affordance', async () => {
    const onAddAuthor = vi.fn()
    render(<PostCard post={makePost()} onAddAuthor={onAddAuthor} />)
    await userEvent.click(screen.getByRole('button', { name: /add jane doe to creators/i }))
    expect(onAddAuthor).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
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

  it('shows a group-size indicator only when part of an image group', () => {
    const { rerender } = render(<PostCard post={makePost({ imageGroupSize: 4 })} />)
    expect(screen.getByText(/4/).closest('[data-testid="group-size"]')).toBeInTheDocument()
    rerender(<PostCard post={makePost({ imageGroupSize: 1 })} />)
    expect(screen.queryByTestId('group-size')).not.toBeInTheDocument()
  })
})
