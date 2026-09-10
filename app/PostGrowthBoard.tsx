'use client'
// Layer 5 — PostGrowthBoard (§22): how each recent post GREW, not just how it finished.
//
// The columns are deliberately day-1 / day-2 / day-3 rather than raw totals: posts only compare at
// equal age. A dash means the post is too young to have that day yet, never zero.
//
// `% late` is the column worth reading — the share of engagement that arrived after day one. Two
// posts can finish on the same number, one having taken it all in an afternoon and the other having
// compounded for three days, and only the second is a repeatable format.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import type { PostGrowthRow } from '@/lib/post-growth-query'
import { safeHref } from '@/lib/pure/url'

const WINDOWS = [3, 7, 30] as const
type Window = (typeof WINDOWS)[number]

const nf = new Intl.NumberFormat('en-US')
const num = (n: number | null): string => (n === null ? '—' : nf.format(n))

export function PostGrowthBoard(): JSX.Element {
  const [days, setDays] = useState<Window>(7)
  const [posts, setPosts] = useState<PostGrowthRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((d: Window) => {
    setError(null)
    apiFetch<{ posts?: PostGrowthRow[] }>(`/api/post-growth?days=${d}`)
      .then((b) => setPosts(b.posts ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load post growth'))
  }, [])

  useEffect(() => load(days), [load, days])

  return (
    <section className="pgrowth">
      <header className="growth__header">
        <div>
          <h2>Post growth</h2>
          <p className="growth__meta">
            Engagement at equal age. A dash means the post is not that old yet.
          </p>
        </div>
        <div className="growth__windows" role="group" aria-label="Post window">
          {WINDOWS.map((w) => (
            <button key={w} type="button" aria-pressed={days === w} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p className="growth__error" role="alert">
          Couldn’t load post growth: {error}
        </p>
      )}

      {posts && posts.length === 0 && !error && (
        <p className="growth__note">Nothing measured yet — the curve starts after the second daily re-scrape.</p>
      )}

      {posts && posts.length > 0 && (
        <div className="growth-board__scroll">
          <table className="growth-table" aria-label="Post growth">
            <thead>
              <tr>
                <th scope="col">Creator</th>
                <th scope="col">Post</th>
                <th scope="col">Day 1</th>
                <th scope="col">Day 2</th>
                <th scope="col">Day 3</th>
                <th scope="col">Now</th>
                <th scope="col">+Today</th>
                <th scope="col">% late</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td>{p.author_name ?? p.author_id}</td>
                  <td className="pgrowth__excerpt">
                    {p.url ? (
                      <a href={safeHref(p.url) ?? undefined} target="_blank" rel="noreferrer">
                        {(p.content ?? '').slice(0, 60) || 'post'}
                      </a>
                    ) : (
                      (p.content ?? '').slice(0, 60)
                    )}
                    {p.still_climbing && (
                      <span className="growth-stale" title="Still gaining — the latest day added a meaningful share">
                        climbing
                      </span>
                    )}
                  </td>
                  <td>{num(p.day1)}</td>
                  <td>{num(p.day2)}</td>
                  <td>{num(p.day3)}</td>
                  <td>{nf.format(p.current_total)}</td>
                  <td className={p.gained_today && p.gained_today > 0 ? 'growth-delta growth-delta--up' : 'growth-delta'}>
                    {p.gained_today === null ? '—' : p.gained_today > 0 ? `+${nf.format(p.gained_today)}` : nf.format(p.gained_today)}
                  </td>
                  <td>{p.pct_after_day1 === null ? '—' : `${p.pct_after_day1.toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
