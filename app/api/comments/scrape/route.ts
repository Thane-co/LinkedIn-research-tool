// Layer 4 — POST /api/comments/scrape (§23). Scrapes the comments on HER OWN posts: every recent post
// by default, or the given postIds. Mutating AND billable, so it takes the CSRF guard, gates on the
// Apify token and her author id, and returns the run's cost. Naming someone else's post is a 403.

import { NextResponse } from 'next/server'
import { NotOwnPostError, scrapeOwnPostComments, type CommentScrapeOptions } from '@/jobs/scrape-comments'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { getKey } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/** Validate the optional body: the scrape options, or the message for a 400. */
function parseOptions(body: unknown): CommentScrapeOptions | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object'
  const { postIds, days, force } = body as Record<string, unknown>
  const opts: CommentScrapeOptions = {}
  if (postIds !== undefined) {
    if (!Array.isArray(postIds) || !postIds.every((id) => typeof id === 'string' && id !== '')) {
      return 'postIds must be an array of post ids'
    }
    opts.postIds = postIds as string[]
  }
  if (days !== undefined) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650) {
      return 'days must be a whole number from 1 to 3650'
    }
    opts.days = days
  }
  if (force !== undefined) {
    if (typeof force !== 'boolean') return 'force must be true or false'
    opts.force = force
  }
  return opts
}

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  const needs = ['apify_api_token', 'own_linkedin_author_id'].filter((key) => !getKey(key))
  if (needs.length > 0) return NextResponse.json({ needs }, { status: 412 })

  // An empty body means "my recent posts"; the launchd-style callers send none.
  const text = await req.text()
  let body: unknown = {}
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'body is not valid JSON' }, { status: 400 })
    }
  }
  const opts = parseOptions(body)
  if (typeof opts === 'string') return NextResponse.json({ error: opts }, { status: 400 })

  try {
    return NextResponse.json(await scrapeOwnPostComments(opts))
  } catch (err) {
    if (err instanceof NotOwnPostError) {
      return NextResponse.json({ error: err.message, refused: err.postIds }, { status: 403 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
