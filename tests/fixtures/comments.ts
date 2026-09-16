// Fixtures for comment repo/route tests (PRD §23). Override only the fields a test cares about.

import type { CommentRow } from '@/lib/types'

export function makeCommentRow(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 'c1',
    post_id: '100',
    parent_comment_id: null,
    author_name: 'Jane Doe',
    author_id: 'jane-doe',
    author_url: 'https://www.linkedin.com/in/jane-doe',
    author_headline: 'Founder',
    author_type: 'profile',
    is_post_author: 0,
    text: 'Great post',
    likes: 0,
    replies: 0,
    pinned: 0,
    edited: 0,
    commented_at: '2026-09-14T10:00:00.000Z',
    scraped_at: '2026-09-15T12:00:00.000Z',
    raw_data: '{}',
    ...overrides,
  }
}
