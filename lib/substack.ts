// Layer 2 — Substack public reader API (§17). NO auth/token needed.
// The Apify actor returns some notes empty (body '' , no attachment) — those are "post-share" / quote
// notes that reference an article. The reader API exposes the attached post's title/subtitle/cover/url,
// so we can backfill an otherwise-blank note. Non-fatal: any failure returns null and the note is dropped.

import { fetchWithTimeout } from '@/lib/http'

const READER_API = 'https://substack.com/api/v1/reader/comment'
const NOTE_TIMEOUT_MS = 15_000
// Substack blocks non-browser UAs on this endpoint, so present a browser one.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export interface NoteContent {
  content: string | null
  imageUrl: string | null
}

interface ReaderResponse {
  item?: {
    comment?: {
      body?: string | null
      attachments?: {
        type?: string
        post?: { title?: string; subtitle?: string; cover_image?: string }
      }[]
    }
  }
}

/**
 * Fetch a note's displayable content from the public reader API, or null on any failure.
 * A note with a real body returns that; a post-share note returns the attached article's
 * title + subtitle (content), cover image, and canonical url.
 */
export async function fetchSubstackNoteContent(noteId: string): Promise<NoteContent | null> {
  try {
    const res = await fetchWithTimeout(
      `${READER_API}/${encodeURIComponent(noteId)}`,
      { headers: { 'user-agent': UA } },
      NOTE_TIMEOUT_MS,
    )
    if (!res.ok) return null
    const c = ((await res.json()) as ReaderResponse)?.item?.comment
    if (!c) return null

    const body = (c.body ?? '').trim()
    if (body) return { content: body, imageUrl: null }

    // A post-share/quote note: surface the referenced article's title + subtitle + cover. We do NOT
    // adopt the article's url (it collides with that same article scraped as a post — unique-url index);
    // the note keeps its own url.
    const post = (c.attachments ?? []).find((a) => a?.type === 'post')?.post
    if (post) {
      const content = [post.title, post.subtitle].filter(Boolean).join('\n\n') || null
      return { content, imageUrl: post.cover_image ?? null }
    }
    return null
  } catch {
    return null
  }
}
