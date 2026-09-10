'use client'
// Layer 5 — TrackedCreatorPicker (§21.8): choose which creators the daily follower capture covers.
//
// This is the second list. Everyone here is already in the scrape roster and stays there — their
// posts keep being collected for content research either way. The checkbox only decides who costs a
// daily profile call and appears on the champion leaderboard.
//
// A failed save REVERTS the checkbox. An optimistic tick left standing after a failed write would
// tell you a creator is tracked when tomorrow's capture will skip them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

interface PickRow {
  id: string
  author_id: string | null
  display_name: string | null
  avatar_url: string | null
  tracked: boolean
  followers: number | null
  posts_30d: number
  best_x_factor: number | null
}

interface Roster {
  creators: PickRow[]
  total: number
  tracked_count: number
  monthly_cost: number
}

const nf = new Intl.NumberFormat('en-US')
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function TrackedCreatorPicker({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    setError(null)
    apiFetch<Roster>('/api/creators/tracking')
      .then(setRoster)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load creators'))
  }, [])

  useEffect(() => load(), [load])

  const visible = useMemo(() => {
    // A partial body must degrade to an empty list, never take the Growth tab down with it.
    const all = roster?.creators ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return all
    return all.filter((c) =>
      `${c.display_name ?? ''} ${c.author_id ?? ''}`.toLowerCase().includes(q),
    )
  }, [roster, filter])

  async function toggle(row: PickRow, tracked: boolean): Promise<void> {
    setError(null)
    // Optimistic, but reverted on failure — see the header note.
    setRoster((r) =>
      r
        ? {
            ...r,
            creators: r.creators.map((c) => (c.id === row.id ? { ...c, tracked } : c)),
            tracked_count: r.tracked_count + (tracked ? 1 : -1),
            monthly_cost: (r.tracked_count + (tracked ? 1 : -1)) * 0.004 * 30,
          }
        : r,
    )
    try {
      await apiFetch('/api/creators/tracking', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: row.id, tracked }),
      })
      onChanged()
    } catch (e) {
      setRoster((r) =>
        r
          ? {
              ...r,
              creators: r.creators.map((c) => (c.id === row.id ? { ...c, tracked: !tracked } : c)),
              tracked_count: r.tracked_count + (tracked ? -1 : 1),
              monthly_cost: (r.tracked_count + (tracked ? -1 : 1)) * 0.004 * 30,
            }
          : r,
      )
      setError(e instanceof Error ? e.message : 'Failed to save')
    }
  }

  return (
    <details className="picker">
      <summary className="picker__summary">
        <h3>Tracked creators</h3>
        {roster && (
          <span className="picker__count">
            {roster.tracked_count} of {roster.total} tracked · {money.format(roster.monthly_cost)}/month
          </span>
        )}
      </summary>

      <div className="picker__body">
        <p className="picker__hint">
          Everyone below stays in the scrape roster for content research. Ticking a creator adds them to
          the daily follower capture and the leaderboard, at $0.004 per day each.
        </p>

        {error && (
          <p className="growth__error" role="alert">
            {error}
          </p>
        )}

        <input
          type="search"
          className="picker__filter"
          aria-label="Filter creators"
          placeholder="Filter by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <ul className="picker__list">
          {visible.map((c) => (
            <li key={c.id} className="picker__row">
              <label>
                <input
                  type="checkbox"
                  checked={c.tracked}
                  onChange={(e) => void toggle(c, e.target.checked)}
                />
                <span className="picker__name">{c.display_name ?? c.author_id}</span>
              </label>
              <span className="picker__stats">
                {c.followers === null ? 'no count yet' : `${nf.format(c.followers)} followers`} ·{' '}
                {c.posts_30d} posts/30d
                {c.best_x_factor !== null && ` · best ${c.best_x_factor.toFixed(1)}x`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}
