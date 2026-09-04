import { describe, expect, it } from 'vitest'
import {
  isSubstackContent,
  mapApifyInstagramToRow,
  mapApifyPostToRow,
  mapApifyProfileToRow,
  mapApifySubstackToRow,
  mapApifyTweetToRow,
  substackNoteHasContent,
} from '@/lib/pure/mappers'
import type { ApifyInstagramPost, ApifyPost, ApifyProfile, ApifySubstackPost, ApifyTweet } from '@/lib/types'

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

  it('takes the first post image url as the thumbnail, or null when there are none', () => {
    expect(mapApifyPostToRow(linkedInRaw(), 'ai').image_url).toBe('https://img/1.png')
    expect(mapApifyPostToRow(linkedInRaw({ postImages: [] }), 'ai').image_url).toBeNull()
  })

  it('serializes media JSON (image) and sets a document thumbnail + media', () => {
    const img = mapApifyPostToRow(linkedInRaw(), 'ai')
    expect(JSON.parse(img.media!)).toEqual({ type: 'image', images: ['https://img/1.png'] })

    const docRaw = linkedInRaw({
      postImages: [],
      document: {
        title: 'Deck',
        transcribedDocumentUrl: 'https://doc/pdf',
        totalPageCount: 12,
        coverPages: [{ imageUrls: ['low', 'high'] }],
      },
    })
    const doc = mapApifyPostToRow(docRaw, 'ai')
    expect(doc.image_url).toBe('high') // thumbnail = document cover
    expect(JSON.parse(doc.media!)).toEqual({ type: 'document', url: 'https://doc/pdf', title: 'Deck', pages: 12, cover: 'high' })
  })

  it('leaves media null when the post has none', () => {
    expect(mapApifyPostToRow(linkedInRaw({ postImages: [] }), 'ai').media).toBeNull()
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

const substackRaw = (over: Partial<ApifySubstackPost> = {}): ApifySubstackPost => ({
  id: 12345,
  slug: 'the-full-breakdown',
  url: 'https://laraacosta.substack.com/p/the-full-breakdown',
  title: 'The full breakdown',
  subtitle: 'What I learned this week',
  bodyMarkdown: 'Long form body here.',
  publishedAt: '2026-07-06T09:00:00.000Z',
  publicationHandle: 'laraacosta',
  publicationName: 'Lara Acosta',
  reactionCount: 412,
  commentCount: 37,
  restackCount: 21,
  coverImage: 'https://substackcdn.com/cover.png',
  ...over,
})

describe('mapApifySubstackToRow (Substack)', () => {
  it('prefixes the id with substack- to avoid collisions', () => {
    expect(mapApifySubstackToRow(substackRaw(), 'ai').id).toBe('substack-12345')
  })

  it('falls back to the slug when the numeric id is absent', () => {
    expect(mapApifySubstackToRow(substackRaw({ id: undefined }), 'ai').id).toBe('substack-the-full-breakdown')
  })

  it('throws when neither id nor slug is present', () => {
    expect(() => mapApifySubstackToRow(substackRaw({ id: undefined, slug: undefined }), 'ai')).toThrow()
  })

  it('maps the publication handle as the clean author_id and derives author_url', () => {
    const row = mapApifySubstackToRow(substackRaw(), 'ai')
    expect(row.author_id).toBe('laraacosta')
    expect(row.author_name).toBe('Lara Acosta')
    expect(row.author_type).toBe('profile')
    expect(row.author_url).toBe('https://laraacosta.substack.com')
  })

  it('prefers an explicit author name, then publicationName, then the handle', () => {
    expect(mapApifySubstackToRow(substackRaw({ author: { name: 'Lara A.' } }), 'ai').author_name).toBe('Lara A.')
    expect(mapApifySubstackToRow(substackRaw({ publicationName: undefined }), 'ai').author_name).toBe('laraacosta')
  })

  it('prefers an explicit publicationUrl for author_url', () => {
    const row = mapApifySubstackToRow(substackRaw({ publicationUrl: 'https://custom.domain.com' }), 'ai')
    expect(row.author_url).toBe('https://custom.domain.com')
  })

  it('nulls author_url / author_id / author_name gracefully when there is no publication handle', () => {
    const row = mapApifySubstackToRow(
      substackRaw({ publicationHandle: undefined, publicationName: undefined }),
      'ai',
    )
    expect(row.author_id).toBeNull()
    expect(row.author_url).toBeNull()
    expect(row.author_name).toBeNull()
  })

  it('nulls content when title, subtitle and body are all absent', () => {
    const row = mapApifySubstackToRow(
      substackRaw({ title: null, subtitle: null, bodyMarkdown: null }),
      'ai',
    )
    expect(row.content).toBeNull()
  })

  it('nulls url when the raw item has none', () => {
    expect(mapApifySubstackToRow(substackRaw({ url: undefined }), 'ai').url).toBeNull()
  })

  it('composes content from title, subtitle and body', () => {
    expect(mapApifySubstackToRow(substackRaw(), 'ai').content).toBe(
      'The full breakdown\n\nWhat I learned this week\n\nLong form body here.',
    )
  })

  it('maps reactions/comments/restacks onto likes/comments/shares (default 0)', () => {
    const row = mapApifySubstackToRow(substackRaw(), 'ai')
    expect({ likes: row.likes, comments: row.comments, shares: row.shares }).toEqual({
      likes: 412,
      comments: 37,
      shares: 21,
    })
    const bare = mapApifySubstackToRow(
      substackRaw({ reactionCount: undefined, commentCount: undefined, restackCount: undefined }),
      'ai',
    )
    expect({ likes: bare.likes, comments: bare.comments, shares: bare.shares }).toEqual({
      likes: 0,
      comments: 0,
      shares: 0,
    })
  })

  it('normalizes publishedAt to ISO and never throws on a bad/absent date', () => {
    expect(mapApifySubstackToRow(substackRaw(), 'ai').posted_at).toBe('2026-07-06T09:00:00.000Z')
    expect(mapApifySubstackToRow(substackRaw({ publishedAt: 'not-a-date' }), 'ai').posted_at).toBeNull()
    expect(mapApifySubstackToRow(substackRaw({ publishedAt: null }), 'ai').posted_at).toBeNull()
  })

  it('maps the cover image to image media + thumbnail, or null when absent', () => {
    const withCover = mapApifySubstackToRow(substackRaw(), 'ai')
    expect(withCover.image_url).toBe('https://substackcdn.com/cover.png')
    expect(JSON.parse(withCover.media!)).toEqual({ type: 'image', images: ['https://substackcdn.com/cover.png'] })

    const noCover = mapApifySubstackToRow(substackRaw({ coverImage: null }), 'ai')
    expect(noCover.image_url).toBeNull()
    expect(noCover.media).toBeNull()
  })

  it('sets platform/market/scraped_at and leaves enrichment + x-factor null', () => {
    const row = mapApifySubstackToRow(substackRaw(), 'ai')
    expect(row.platform).toBe('substack')
    expect(row.market).toBe('ai')
    expect(row.scraped_at).toMatch(ISO_RE)
    expect(row.is_repost).toBe(0)
    expect(row.embedding).toBeNull()
    expect(row.x_factor).toBeNull()
  })

  it('maps a Substack NOTE record (type:note): real fields authorHandle/authorName/body/createdAt', () => {
    const note = mapApifySubstackToRow(
      {
        type: 'note',
        kind: 'note',
        id: '291136901',
        authorHandle: 'aliciateltz',
        authorName: 'Alicia Teltz',
        body: 'a quick note about ai',
        createdAt: '2026-07-09T11:50:00.000Z',
        reactionCount: 15,
        attachmentUrls: ['https://cdn/note-img.png'],
      },
      'ai',
    )
    expect(note.id).toBe('substack-note-291136901') // distinct prefix from posts (substack-…)
    expect(note.platform).toBe('substack')
    expect(note.author_id).toBe('aliciateltz')
    expect(note.author_name).toBe('Alicia Teltz')
    expect(note.content).toBe('a quick note about ai')
    expect(note.url).toBe('https://substack.com/@aliciateltz/note/c-291136901')
    expect(note.posted_at).toBe('2026-07-09T11:50:00.000Z')
    expect({ likes: note.likes, comments: note.comments, shares: note.shares }).toEqual({ likes: 15, comments: 0, shares: 0 })
    expect(note.image_url).toBe('https://cdn/note-img.png')
    expect(JSON.parse(note.media!)).toEqual({ type: 'image', images: ['https://cdn/note-img.png'] })
    expect(note.is_repost).toBe(0)
  })

  it('an image-only note (empty body) still maps: null content, author + image kept', () => {
    const note = mapApifySubstackToRow(
      { type: 'note', kind: 'note', id: 'n2', authorHandle: 'lara', authorName: 'Lara', body: '', reactionCount: 10 },
      'ai',
    )
    expect(note.content).toBeNull() // empty body → null (not a blank string)
    expect(note.author_id).toBe('lara')
    expect(note.likes).toBe(10)
  })

  it('a restack note surfaces the boosted article (title as content, link to the article)', () => {
    const restack = mapApifySubstackToRow(
      {
        type: 'note',
        kind: 'restack',
        id: 'r9',
        authorHandle: 'aliciateltz',
        restackedPost: { title: 'WATCH BACK: Substack Live', url: 'https://dealmakers.substack.com/p/watch-back' },
      },
      'ai',
    )
    expect(restack.is_repost).toBe(1)
    expect(restack.content).toBe('WATCH BACK: Substack Live') // the boosted article title as content
    expect(restack.url).toBe('https://substack.com/@aliciateltz/note/c-r9') // its OWN note url (no collision)
  })

  it('a bare note (no author handle, no content) is null-safe', () => {
    const restack = mapApifySubstackToRow({ type: 'note', kind: 'restack', id: 'r1' }, 'ai')
    expect(restack.id).toBe('substack-note-r1')
    expect(restack.author_id).toBeNull()
    expect(restack.author_name).toBeNull()
    expect(restack.url).toBeNull()
    expect(restack.content).toBeNull()
    expect(restack.media).toBeNull()
  })

  it('note author_name falls back to the handle when authorName is absent', () => {
    const note = mapApifySubstackToRow({ type: 'note', id: 'n3', authorHandle: 'jantegze' }, 'ai')
    expect(note.author_name).toBe('jantegze')
  })

  it('throws on a note with no id', () => {
    expect(() => mapApifySubstackToRow({ type: 'note', kind: 'note' }, 'ai')).toThrow()
  })

  it('substackNoteHasContent keeps notes with text/image/restack, drops the truly empty', () => {
    expect(substackNoteHasContent({ body: 'hi' })).toBe(true)
    expect(substackNoteHasContent({ attachmentUrls: ['x'] })).toBe(true)
    expect(substackNoteHasContent({ restackedPost: { title: 't' } })).toBe(true)
    expect(substackNoteHasContent({ restackedPublication: { name: 'p' } })).toBe(true)
    expect(substackNoteHasContent({ body: '   ' })).toBe(false) // whitespace-only
    expect(substackNoteHasContent({})).toBe(false) // nothing displayable
  })

  it('isSubstackContent keeps posts + notes but rejects author/publication metadata records', () => {
    expect(isSubstackContent({ type: 'post' })).toBe(true)
    expect(isSubstackContent({ type: 'note' })).toBe(true)
    expect(isSubstackContent({})).toBe(true) // no type → treated as a post
    expect(isSubstackContent({ type: 'author' })).toBe(false) // profile metadata, not content
    expect(isSubstackContent({ type: 'publication' })).toBe(false)
  })
})

const instagramRaw = (over: Partial<ApifyInstagramPost> = {}): ApifyInstagramPost => ({
  id: '3660778310592222546',
  shortCode: 'DLNsnpUTdVS',
  url: 'https://www.instagram.com/p/DLNsnpUTdVS/',
  caption: 'Your phone isn’t rotting your brain',
  type: 'Image',
  likesCount: 73473,
  commentsCount: 230,
  videoViewCount: null,
  timestamp: '2026-06-22T19:00:10.000Z',
  ownerUsername: 'natgeo',
  ownerFullName: 'National Geographic',
  ownerId: '787132',
  displayUrl: 'https://ig.cdn/img.jpg',
  videoUrl: null,
  images: [],
  ...over,
})

describe('mapApifyInstagramToRow (Instagram §18)', () => {
  it('prefixes the id with instagram- (derived from the shortCode)', () => {
    expect(mapApifyInstagramToRow(instagramRaw(), 'ai').id).toBe('instagram-DLNsnpUTdVS')
  })

  it('falls back to raw.id when the shortCode is missing', () => {
    expect(mapApifyInstagramToRow(instagramRaw({ shortCode: undefined }), 'ai').id).toBe('instagram-3660778310592222546')
  })

  it('throws when neither shortCode nor id can be derived', () => {
    expect(() => mapApifyInstagramToRow(instagramRaw({ shortCode: undefined, id: undefined }), 'ai')).toThrow()
  })

  it('builds the canonical url from the shortCode when url is absent', () => {
    expect(mapApifyInstagramToRow(instagramRaw({ url: undefined }), 'ai').url).toBe(
      'https://www.instagram.com/p/DLNsnpUTdVS/',
    )
  })

  it('maps author fields from ownerUsername/ownerFullName', () => {
    const row = mapApifyInstagramToRow(instagramRaw(), 'ai')
    expect(row.author_id).toBe('natgeo')
    expect(row.author_name).toBe('National Geographic')
    expect(row.author_url).toBe('https://www.instagram.com/natgeo/')
    expect(row.author_type).toBe('profile')
  })

  it('falls back author_name to the handle when ownerFullName is absent', () => {
    expect(mapApifyInstagramToRow(instagramRaw({ ownerFullName: null }), 'ai').author_name).toBe('natgeo')
  })

  it('maps engagement (shares are always 0 — Instagram has no reshare count)', () => {
    const row = mapApifyInstagramToRow(instagramRaw(), 'ai')
    expect(row.likes).toBe(73473)
    expect(row.comments).toBe(230)
    expect(row.shares).toBe(0)
  })

  it('defaults missing engagement counts to 0', () => {
    const row = mapApifyInstagramToRow(instagramRaw({ likesCount: undefined, commentsCount: undefined }), 'ai')
    expect(row.likes).toBe(0)
    expect(row.comments).toBe(0)
  })

  it('parses timestamp to ISO, null when absent/unparseable', () => {
    expect(mapApifyInstagramToRow(instagramRaw(), 'ai').posted_at).toBe('2026-06-22T19:00:10.000Z')
    expect(mapApifyInstagramToRow(instagramRaw({ timestamp: null }), 'ai').posted_at).toBeNull()
    expect(mapApifyInstagramToRow(instagramRaw({ timestamp: 'not-a-date' }), 'ai').posted_at).toBeNull()
  })

  it('maps a single image post to image media + thumbnail', () => {
    const row = mapApifyInstagramToRow(instagramRaw(), 'ai')
    expect(row.image_url).toBe('https://ig.cdn/img.jpg')
    expect(JSON.parse(row.media!)).toEqual({ type: 'image', images: ['https://ig.cdn/img.jpg'] })
  })

  it('maps a video post to video media (poster = displayUrl)', () => {
    const row = mapApifyInstagramToRow(
      instagramRaw({ type: 'Video', videoUrl: 'https://ig.cdn/reel.mp4' }),
      'ai',
    )
    expect(JSON.parse(row.media!)).toEqual({
      type: 'video',
      url: 'https://ig.cdn/reel.mp4',
      poster: 'https://ig.cdn/img.jpg',
    })
    expect(row.image_url).toBe('https://ig.cdn/img.jpg')
  })

  it('sets platform, market, is_repost=0, and a fresh scraped_at', () => {
    const row = mapApifyInstagramToRow(instagramRaw(), 'mkt')
    expect(row.platform).toBe('instagram')
    expect(row.market).toBe('mkt')
    expect(row.is_repost).toBe(0)
    expect(row.scraped_at).toMatch(ISO_RE)
    expect(row.content).toBe('Your phone isn’t rotting your brain')
    expect(JSON.parse(row.raw_data!).ownerId).toBe('787132')
  })

  it('nulls author_url when the owner handle is absent', () => {
    const row = mapApifyInstagramToRow(instagramRaw({ ownerUsername: undefined, ownerFullName: undefined }), 'ai')
    expect(row.author_id).toBeNull()
    expect(row.author_url).toBeNull()
    expect(row.author_name).toBeNull()
  })

  it('nulls url + content when both url/shortCode and caption are absent (id from raw.id)', () => {
    const row = mapApifyInstagramToRow(instagramRaw({ url: undefined, shortCode: undefined, caption: null }), 'ai')
    expect(row.id).toBe('instagram-3660778310592222546') // fell back to raw.id
    expect(row.url).toBeNull() // no url and no shortCode to build one from
    expect(row.content).toBeNull()
  })

  it('leaves media/image_url null when the post carries no media at all', () => {
    const row = mapApifyInstagramToRow(instagramRaw({ type: 'Image', displayUrl: null, images: [] }), 'ai')
    expect(row.media).toBeNull()
    expect(row.image_url).toBeNull()
  })
})

const profileRaw = (over: Partial<ApifyProfile> = {}): ApifyProfile => ({
  publicIdentifier: 'basiakubicka',
  linkedinUrl: 'https://www.linkedin.com/in/basiakubicka/',
  firstName: 'Basia',
  lastName: 'Kubicka',
  headline: 'AI PM',
  about: 'I build AI products.',
  photo: 'https://img/basia.png',
  location: 'Cambridge, Massachusetts',
  followerCount: 69000,
  connectionsCount: 500,
  experience: [{ company: 'Techstars startup', position: 'CEO' }],
  education: [{ school: 'Frankfurt UAS' }],
  skills: [{ name: 'Product Management' }],
  ...over,
})

describe('mapApifyProfileToRow (LinkedIn profile, §19)', () => {
  it('uses the clean publicIdentifier as the row id', () => {
    expect(mapApifyProfileToRow(profileRaw()).id).toBe('basiakubicka')
  })

  it('falls back to the slug parsed from linkedinUrl when publicIdentifier is absent', () => {
    const row = mapApifyProfileToRow(profileRaw({ publicIdentifier: undefined }))
    expect(row.id).toBe('basiakubicka')
  })

  it('throws when neither publicIdentifier nor a url slug yields an id', () => {
    expect(() => mapApifyProfileToRow(profileRaw({ publicIdentifier: undefined, linkedinUrl: undefined }))).toThrow(
      /profile id/i,
    )
    // a url with no /in/<slug> segment can't yield an id either
    expect(() =>
      mapApifyProfileToRow(profileRaw({ publicIdentifier: undefined, linkedinUrl: 'https://linkedin.com/feed/' })),
    ).toThrow(/profile id/i)
  })

  it('maps the follower and connection counts (default 0 when absent)', () => {
    expect(mapApifyProfileToRow(profileRaw()).followers).toBe(69000)
    expect(mapApifyProfileToRow(profileRaw()).connections).toBe(500)
    const bare = mapApifyProfileToRow(profileRaw({ followerCount: undefined, connectionsCount: undefined }))
    expect(bare.followers).toBe(0)
    expect(bare.connections).toBe(0)
  })

  it('joins first + last into name, else uses raw.name, else null', () => {
    expect(mapApifyProfileToRow(profileRaw()).name).toBe('Basia Kubicka')
    expect(mapApifyProfileToRow(profileRaw({ firstName: undefined, lastName: undefined, name: 'Fallback' })).name).toBe(
      'Fallback',
    )
    expect(
      mapApifyProfileToRow(profileRaw({ firstName: undefined, lastName: undefined, name: undefined })).name,
    ).toBeNull()
  })

  it('coerces location from a string or a parsed object, else null', () => {
    expect(mapApifyProfileToRow(profileRaw()).location).toBe('Cambridge, Massachusetts')
    expect(mapApifyProfileToRow(profileRaw({ location: { linkedinText: 'Boston, MA' } })).location).toBe('Boston, MA')
    expect(mapApifyProfileToRow(profileRaw({ location: { text: 'NYC' } })).location).toBe('NYC')
    expect(mapApifyProfileToRow(profileRaw({ location: {} })).location).toBeNull()
    expect(mapApifyProfileToRow(profileRaw({ location: null })).location).toBeNull()
  })

  it('stores experience/education/skills as JSON, null when empty/absent', () => {
    const row = mapApifyProfileToRow(profileRaw())
    expect(JSON.parse(row.experience!)).toEqual([{ company: 'Techstars startup', position: 'CEO' }])
    expect(JSON.parse(row.skills!)).toEqual([{ name: 'Product Management' }])
    const empty = mapApifyProfileToRow(profileRaw({ experience: [], education: undefined, skills: [] }))
    expect(empty.experience).toBeNull()
    expect(empty.education).toBeNull()
    expect(empty.skills).toBeNull()
  })

  it('maps headline/about/avatar, keeps the canonical url, sets an ISO scraped_at, preserves raw_data', () => {
    const row = mapApifyProfileToRow(profileRaw())
    expect(row.headline).toBe('AI PM')
    expect(row.about).toBe('I build AI products.')
    expect(row.avatar_url).toBe('https://img/basia.png')
    expect(row.url).toBe('https://www.linkedin.com/in/basiakubicka/')
    expect(row.scraped_at).toMatch(ISO_RE)
    expect(JSON.parse(row.raw_data!).publicIdentifier).toBe('basiakubicka')
  })

  it('synthesizes a canonical url from the id when linkedinUrl is absent', () => {
    const row = mapApifyProfileToRow(profileRaw({ linkedinUrl: undefined }))
    expect(row.url).toBe('https://www.linkedin.com/in/basiakubicka/')
    expect(row.headline).toBe('AI PM')
    // nullish fields default cleanly
    const sparse = mapApifyProfileToRow({ publicIdentifier: 'x' })
    expect(sparse.headline).toBeNull()
    expect(sparse.about).toBeNull()
    expect(sparse.avatar_url).toBeNull()
    expect(sparse.name).toBeNull()
  })
})
