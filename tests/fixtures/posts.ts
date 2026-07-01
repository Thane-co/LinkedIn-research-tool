// Fixtures for seeding :memory: db in repo/job tests (PRD §13).
// A factory keeps rows terse; override only the fields a test cares about.

import type { PostRow } from '@/lib/types'

export function makePostRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: 'activity-1',
    platform: 'linkedin',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
    content: 'sample content',
    author_name: 'Sample Author',
    author_url: 'https://www.linkedin.com/in/sample',
    author_id: 'sample',
    author_type: 'profile',
    likes: 0,
    shares: 0,
    comments: 0,
    posted_at: '2026-06-01T00:00:00.000Z',
    scraped_at: '2026-06-30T00:00:00.000Z',
    is_repost: 0,
    scrape_source: 'keyword',
    market: 'ai',
    embedding: null,
    image_url: null,
    image_description: null,
    image_embedding: null,
    embedded_at: null,
    weighted_score: null,
    creator_baseline: null,
    x_factor: null,
    raw_data: null,
    ...overrides,
  }
}
