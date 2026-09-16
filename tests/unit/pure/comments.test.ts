import { describe, expect, it } from 'vitest'
import {
  flattenCommentItems,
  mapApifyCommentToRow,
  parentCommentId,
  selectPostsToScrape,
  serializeComment,
} from '@/lib/pure/comments'
import { makeCommentRow } from '@/tests/fixtures/comments'
import type { ApifyComment } from '@/lib/types'

const POST = '7504887287340482560'
const SCRAPED_AT = '2026-09-15T12:00:00.000Z'
const urn = (comment: string): string => encodeURIComponent(`urn:li:comment:(activity:${POST},${comment})`)
const commentUrl = (comment: string, reply?: string): string =>
  `https://www.linkedin.com/feed/update/urn:li:activity:${POST}?commentUrn=${urn(comment)}` +
  (reply ? `&replyUrn=${urn(reply)}` : '')

const raw = (over: Partial<ApifyComment> = {}): ApifyComment => ({
  id: '111',
  linkedinUrl: commentUrl('111'),
  commentary: 'Great post',
  createdAt: '2026-09-14T20:13:37.465Z',
  engagement: { likes: 4, comments: 1, shares: 0, reactions: [] },
  postId: `urn:li:activity:${POST}`,
  pinned: false,
  edited: false,
  actor: {
    type: 'profile',
    universalName: 'jane-doe',
    name: 'Jane Doe',
    linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
    position: 'Founder',
    author: false,
  },
  ...over,
})

describe('mapApifyCommentToRow', () => {
  it('maps a top-level comment onto its post', () => {
    const item = raw()
    expect(mapApifyCommentToRow(item, SCRAPED_AT)).toEqual({
      id: '111',
      post_id: POST,
      parent_comment_id: null,
      author_name: 'Jane Doe',
      author_id: 'jane-doe',
      author_url: 'https://www.linkedin.com/in/jane-doe',
      author_headline: 'Founder',
      author_type: 'profile',
      is_post_author: 0,
      text: 'Great post',
      likes: 4,
      replies: 1,
      pinned: 0,
      edited: 0,
      commented_at: '2026-09-14T20:13:37.465Z',
      scraped_at: SCRAPED_AT,
      raw_data: JSON.stringify(item),
    })
  })

  it('links a reply to the comment it answers', () => {
    const row = mapApifyCommentToRow(raw({ id: '222', linkedinUrl: commentUrl('111', '222') }), SCRAPED_AT)
    expect(row).toMatchObject({ id: '222', parent_comment_id: '111' })
  })

  it('marks a comment written by the post author (her own replies)', () => {
    const row = mapApifyCommentToRow(raw({ actor: { name: 'Basia Kubicka', publicIdentifier: 'basiakubicka', author: true } }), SCRAPED_AT)
    expect(row).toMatchObject({ is_post_author: 1, author_id: 'basiakubicka' })
  })

  it('falls back to the url for the comment id, the reply id, and the post id', () => {
    expect(mapApifyCommentToRow(raw({ id: undefined, postId: undefined }), SCRAPED_AT)).toMatchObject({
      id: '111',
      post_id: POST,
    })
    expect(
      mapApifyCommentToRow(raw({ id: undefined, linkedinUrl: commentUrl('111', '444') }), SCRAPED_AT),
    ).toMatchObject({ id: '444', parent_comment_id: '111' })
  })

  it('stores missing fields as null/0 rather than inventing values', () => {
    const row = mapApifyCommentToRow(
      raw({ actor: undefined, engagement: null, commentary: null, createdAt: undefined, pinned: true, edited: true }),
      SCRAPED_AT,
    )
    expect(row).toMatchObject({
      author_name: null, author_id: null, author_url: null, author_headline: null, author_type: null,
      is_post_author: 0, text: null, likes: 0, replies: 0, pinned: 1, edited: 1, commented_at: null,
    })
  })

  it('throws when no comment id can be derived', () => {
    expect(() => mapApifyCommentToRow(raw({ id: undefined, linkedinUrl: undefined }), SCRAPED_AT)).toThrow(/comment id/)
  })

  it('throws when no post id can be derived — an unattached comment is never stored', () => {
    expect(() =>
      mapApifyCommentToRow(raw({ postId: undefined, linkedinUrl: 'https://example.com/x' }), SCRAPED_AT),
    ).toThrow(/post id/)
  })
})

describe('flattenCommentItems', () => {
  it('lifts nested replies out to follow their parent, and strips them from the parent item', () => {
    const reply = raw({ id: '222', linkedinUrl: commentUrl('111', '222') })
    const out = flattenCommentItems([raw({ replies: [reply] }), raw({ id: '333', linkedinUrl: commentUrl('333') })])
    expect(out.map((i) => i.id)).toEqual(['111', '222', '333'])
    expect(out[0]).not.toHaveProperty('replies')
    expect(mapApifyCommentToRow(out[1]!, SCRAPED_AT)).toMatchObject({ id: '222', parent_comment_id: '111' })
  })

  it('ignores a replies field that is not a list, rather than throwing', () => {
    expect(flattenCommentItems([raw({ replies: 'n/a' })]).map((i) => i.id)).toEqual(['111'])
  })
})

describe('parentCommentId', () => {
  it('is null for a top-level comment, a missing url, or a url with no comment urn', () => {
    expect(parentCommentId(commentUrl('111'))).toBeNull()
    expect(parentCommentId(undefined)).toBeNull()
    expect(parentCommentId('https://www.linkedin.com/feed/update/urn:li:activity:1/')).toBeNull()
  })

  it('is the commentUrn id when the url points at a reply', () => {
    expect(parentCommentId(commentUrl('111', '222'))).toBe('111')
  })

  it('is null when a urn param is present but unreadable, rather than guessing a thread', () => {
    const base = `https://www.linkedin.com/feed/update/urn:li:activity:${POST}`
    expect(parentCommentId(`${base}?commentUrn=garbage&replyUrn=${urn('222')}`)).toBeNull()
    expect(parentCommentId(`${base}?commentUrn=${urn('111')}&replyUrn=garbage`)).toBeNull()
  })
})

describe('selectPostsToScrape', () => {
  const OWN = 'basiakubicka'
  const p = (id: string, author_id: string | null, comments: number) => ({ id, author_id, comments })

  it("refuses any post that isn't hers, whatever its comment count", () => {
    const out = selectPostsToScrape([p('1', 'someone', 500), p('2', null, 10)], new Map(), { ownAuthorId: OWN })
    expect(out).toEqual({ scrape: [], upToDate: [], refused: ['1', '2'] })
  })

  it('scrapes a post with comments not yet stored and skips one already fully stored', () => {
    const stored = new Map([['1', 12], ['2', 3]])
    const out = selectPostsToScrape([p('1', OWN, 12), p('2', OWN, 9), p('3', OWN, 4)], stored, { ownAuthorId: OWN })
    expect(out).toEqual({ scrape: ['2', '3'], upToDate: ['1'], refused: [] })
  })

  it('treats a post with no comments as up to date — there is nothing to pay for', () => {
    expect(selectPostsToScrape([p('1', OWN, 0)], new Map(), { ownAuthorId: OWN }).upToDate).toEqual(['1'])
  })

  it('force re-reads an up-to-date post (edited text, new likes) but still refuses others', () => {
    const out = selectPostsToScrape([p('1', OWN, 0), p('2', 'someone', 5)], new Map([['1', 0]]), {
      ownAuthorId: OWN,
      force: true,
    })
    expect(out).toEqual({ scrape: ['1'], upToDate: [], refused: ['2'] })
  })
})

describe('serializeComment', () => {
  it('drops the raw scraped payload', () => {
    const out = serializeComment(makeCommentRow({ raw_data: '{"big":true}' }))
    expect(out).not.toHaveProperty('raw_data')
    expect(out).toMatchObject({ id: 'c1', post_id: '100', text: 'Great post' })
  })
})
