'use client'
// Layer 5 — CreatorGrowthPanel (§21): one creator's day-by-day follower growth with the post that
// owns each day. This is the "which post earned those followers?" view.
//
// The attribution rule is visible on screen, not hidden in a tooltip: a day with one post credits
// that post, a day with several says SHARED and offers no per-post number, and a day with none still
// shows its growth. Inventing a split across three posts would look exactly like a measurement.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import type { CreatorGrowthDetail } from '@/lib/followers-query'
import { safeHref } from '@/lib/pure/url'

const nf = new Intl.NumberFormat('en-US')

const postUrl = (id: string): string => `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`

export function CreatorGrowthPanel({
  authorId,
  displayName,
  onClose,
}: {
  authorId: string
  displayName: string | null
  onClose: () => void
}): JSX.Element {
  const [detail, setDetail] = useState<CreatorGrowthDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    apiFetch<CreatorGrowthDetail>(`/api/followers/${authorId}?days=30`)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load this creator'))
  }, [authorId])

  useEffect(() => load(), [load])

  // A partial body (a shape change, a proxy rewriting the response) must degrade to "no history",
  // never take the panel down with it.
  const days = detail?.days ?? []

  return (
    <aside className="growth-panel" aria-label={`Follower growth for ${displayName ?? authorId}`}>
      <header className="growth-panel__header">
        <h3>{displayName ?? authorId}</h3>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {error && (
        <p className="growth__error" role="alert">
          Couldn’t load this creator: {error}
        </p>
      )}

      {detail && days.length === 0 && !error && (
        <p className="growth-panel__empty">No daily history yet — it starts after the second capture.</p>
      )}

      {detail && days.length > 0 && (
        <ol className="growth-panel__days">
          {[...days].reverse().map((d) => (
            <li key={d.captured_on} className="growth-day">
              <div className="growth-day__head">
                <span className="growth-day__date">{d.captured_on}</span>
                <span
                  className={
                    d.gained > 0 ? 'growth-delta growth-delta--up' : d.gained < 0 ? 'growth-delta growth-delta--down' : 'growth-delta'
                  }
                >
                  {d.gained > 0 ? `+${nf.format(d.gained)}` : nf.format(d.gained)}
                </span>
                <span className="growth-day__total">{nf.format(d.followers)} total</span>
              </div>
              <div className="growth-day__attr">
                {d.post_count === 0 && <span className="growth-day__muted">No posts that day</span>}
                {d.shared && <span className="growth-day__muted">Shared across {d.post_count} posts</span>}
                {d.attributable_post_id && (
                  <a href={safeHref(postUrl(d.attributable_post_id)) ?? undefined} target="_blank" rel="noreferrer">
                    View post
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
