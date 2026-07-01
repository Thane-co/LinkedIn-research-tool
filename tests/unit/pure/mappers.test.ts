import { describe, expect, it } from 'vitest'
import { mapApifyPostToRow, mapApifyTweetToRow } from '@/lib/pure/mappers'
import type { ApifyPost, ApifyTweet } from '@/lib/types'

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const linkedInRaw = (over: Partial<ApifyPost> = {}): ApifyPost => ({
  id: 'urn:li:feedEvent:222', // a feed-event URN — must NOT be used as the id
  linkedinUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:111/',
  content: 'Hello from LinkedIn',
  author: {
    name: 'Jane Doe',
    linkedinUrl: 'https://www.linkedin.com/in/jane?miniProfileUrn=urn%3Ali%3Ax',
    universalName: 'jane',
    publicIdentifier: 'jane-pub',
    type: 'profile',
  },
  postedAt: { date: '2026-06-01T10:00:00.000Z' },
  engagement: { likes: 10, comments: 2, shares: 1 },
  postImages: [{ url: 'https://img/1.png' }],
  ...over,
})

describe('mapApifyPostToRow (LinkedIn)', () => {
  it('derives the id from the URL activity URN, not raw.id', () => {
    expect(mapApifyPostToRow(linkedInRaw(), 'ai').id).toBe('111')
  })

  it('builds the canonical activity url from the derived id', () => {
    expect(mapApifyPostToRow(linkedInRaw(), 'ai').url).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:111/',
    )
  })

  it('maps author fields; author_id is the clean universalName', () => {
    const row = mapApifyPostToRow(linkedInRaw(), 'ai')
    expect(row.author_id).toBe('jane')
    expect(row.author_name).toBe('Jane Doe')
    expect(row.author_type).toBe('profile')
    // author_url is stored verbatim (query string kept) but is never matched on
    expect(row.author_url).toContain('miniProfileUrn')
  })

  it('falls back to publicIdentifier when universalName is absent', () => {
    const raw = linkedInRaw()
    delete raw.author!.universalName
    expect(mapApifyPostToRow(raw, 'ai').author_id).toBe('jane-pub')
  })

  it('maps engagement and defaults to 0 when engagement is null', () => {
    const row = mapApifyPostToRow(linkedInRaw({ engagement: null }), 'ai')
    expect({ likes: row.likes, comments: row.comments, shares: row.shares }).toEqual({
      likes: 0,
      comments: 0,
      shares: 0,
    })
  })

  it('does not throw on null content', () => {
    const row = mapApifyPostToRow(linkedInRaw({ content: null }), 'ai')
    expect(row.content).toBeNull()
  })

  it('takes the first post image url, or null when there are none', () => {
    expect(mapApifyPostToRow(linkedInRaw(), 'ai').image_url).toBe('https://img/1.png')
    expect(mapApifyPostToRow(linkedInRaw({ postImages: [] }), 'ai').image_url).toBeNull()
  })

  it('sets is_repost from repostedBy', () => {
    expect(mapApifyPostToRow(linkedInRaw(), 'ai').is_repost).toBe(0)
    expect(mapApifyPostToRow(linkedInRaw({ repostedBy: { x: 1 } }), 'ai').is_repost).toBe(1)
  })

  it('sets platform, market, scraped_at (ISO), and leaves enrichment/x-factor null', () => {
    const row = mapApifyPostToRow(linkedInRaw(), 'ai')
    expect(row.platform).toBe('linkedin')
    expect(row.market).toBe('ai')
    expect(row.scraped_at).toMatch(ISO_RE)
    expect(row.embedding).toBeNull()
    expect(row.x_factor).toBeNull()
    expect(JSON.parse(row.raw_data!)).toMatchObject({ linkedinUrl: expect.any(String) })
  })

  it('falls back to raw.id only when the url has no derivable urn', () => {
    const raw = linkedInRaw({ linkedinUrl: 'https://www.linkedin.com/in/jane', id: '555' })
    expect(mapApifyPostToRow(raw, 'ai').id).toBe('555')
  })

  it('throws when no id can be derived from url or raw.id', () => {
    const raw = linkedInRaw({ linkedinUrl: 'https://www.linkedin.com/in/jane', id: undefined })
    expect(() => mapApifyPostToRow(raw, 'ai')).toThrow()
  })

  it('nulls the author fields and posted_at when author / postedAt are absent', () => {
    const row = mapApifyPostToRow(linkedInRaw({ author: undefined, postedAt: undefined }), 'ai')
    expect(row.author_name).toBeNull()
    expect(row.author_url).toBeNull()
    expect(row.author_id).toBeNull()
    expect(row.author_type).toBeNull()
    expect(row.posted_at).toBeNull()
  })
})

const tweetRaw = (over: Partial<ApifyTweet> = {}): ApifyTweet => ({
  id: '9001',
  url: 'https://x.com/jane/status/9001',
  text: 'Hello from X',
  author: { userName: 'jane', isBlueVerified: true },
  createdAt: 'Mon Jun 01 10:00:00 +0000 2026',
  likeCount: 5,
  retweetCount: 3,
  replyCount: 2,
  isRetweet: false,
  ...over,
})

describe('mapApifyTweetToRow (Twitter)', () => {
  it('prefixes the id with tweet- to avoid LinkedIn collisions', () => {
    expect(mapApifyTweetToRow(tweetRaw(), 'ai').id).toBe('tweet-9001')
  })

  it('maps handle, verified type, engagement, and platform', () => {
    const row = mapApifyTweetToRow(tweetRaw(), 'ai')
    expect(row.author_id).toBe('jane')
    expect(row.author_type).toBe('verified')
    expect({ likes: row.likes, shares: row.shares, comments: row.comments }).toEqual({
      likes: 5,
      shares: 3,
      comments: 2,
    })
    expect(row.platform).toBe('twitter')
  })

  it('normalizes createdAt to an ISO-8601 UTC string', () => {
    expect(mapApifyTweetToRow(tweetRaw(), 'ai').posted_at).toBe('2026-06-01T10:00:00.000Z')
  })

  it('marks non-verified authors as profile and defaults engagement to 0', () => {
    const row = mapApifyTweetToRow(
      tweetRaw({ author: { userName: 'joe', isBlueVerified: false }, likeCount: undefined }),
      'ai',
    )
    expect(row.author_type).toBe('profile')
    expect(row.likes).toBe(0)
  })

  it('sets is_repost from isRetweet', () => {
    expect(mapApifyTweetToRow(tweetRaw({ isRetweet: true }), 'ai').is_repost).toBe(1)
  })

  it('throws when the tweet has no id', () => {
    expect(() => mapApifyTweetToRow(tweetRaw({ id: undefined as unknown as string }), 'ai')).toThrow()
  })

  it('falls back to twitterUrl when url is absent', () => {
    const row = mapApifyTweetToRow(
      tweetRaw({ url: undefined, twitterUrl: 'https://x.com/jane/status/9001' }),
      'ai',
    )
    expect(row.url).toBe('https://x.com/jane/status/9001')
  })

  it('handles a missing author and missing url (nulls, not crashes)', () => {
    const row = mapApifyTweetToRow(
      tweetRaw({ author: undefined, url: undefined, twitterUrl: undefined, text: null }),
      'ai',
    )
    expect(row.author_id).toBeNull()
    expect(row.author_url).toBeNull()
    expect(row.author_type).toBe('profile')
    expect(row.url).toBeNull()
    expect(row.content).toBeNull()
  })

  it('defaults retweet/reply counts to 0 when absent', () => {
    const row = mapApifyTweetToRow(
      tweetRaw({ retweetCount: undefined, replyCount: undefined }),
      'ai',
    )
    expect(row.shares).toBe(0)
    expect(row.comments).toBe(0)
  })
})
