'use client'
// Layer 5 — GrowthBoard (§21): the champion leaderboard. Two boards over one window — most followers
// gained, and fastest % growth — plus an on-demand capture of today's numbers.
//
// Two display rules carry the honesty of the data and must not be "tidied up":
//   - A creator with no history renders an em dash, NEVER a 0. Unmeasured is not flat.
//   - The % board is floored at 10,000 followers and says so on screen, so a creator missing from it
//     reads as "too small to rank by rate", not as a bug.

import { useCallback, useEffect, useState } from 'react'
import { CreatorGrowthPanel } from '@/app/CreatorGrowthPanel'
import { PostGrowthBoard } from '@/app/PostGrowthBoard'
import { TrackedCreatorPicker } from '@/app/TrackedCreatorPicker'
import { apiFetch } from '@/lib/api-client'
import type { BoardRow, Leaderboard } from '@/lib/followers-query'

const WINDOWS = [1, 7, 30] as const
type Window = (typeof WINDOWS)[number]

type Capture =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; captured: number; requested: number }
  | { status: 'failed'; error: string }
  | { status: 'blocked'; needs: string[] }

const nf = new Intl.NumberFormat('en-US')

/** A signed count, or an em dash when the number does not exist yet. */
function signed(n: number | null): string {
  if (n === null) return '—'
  return n > 0 ? `+${nf.format(n)}` : nf.format(n)
}

function signedPct(n: number | null): string {
  if (n === null) return '—'
  const v = n.toFixed(2)
  return n > 0 ? `+${v}%` : `${v}%`
}

const deltaClass = (n: number | null): string =>
  n === null ? 'growth-delta growth-delta--none' : n > 0 ? 'growth-delta growth-delta--up' : n < 0 ? 'growth-delta growth-delta--down' : 'growth-delta'

/**
 * A 60x18 sparkline of the follower series. Flat-line series (or a single point) would divide by
 * zero on the y-scale, so they render as a midline instead.
 */
function Sparkline({ points }: { points: number[] }): JSX.Element | null {
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const d = points
    .map((p, i) => `${(i / (points.length - 1)) * 60},${18 - ((p - min) / span) * 16 - 1}`)
    .join(' ')
  return (
    <svg className="growth-spark" viewBox="0 0 60 18" width="60" height="18" aria-hidden="true" focusable="false">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function Board({
  title,
  caption,
  rows,
  metric,
  onSelect,
}: {
  title: string
  caption: string
  rows: BoardRow[]
  metric: 'absolute' | 'percent'
  onSelect: (row: BoardRow) => void
}): JSX.Element {
  return (
    <section className="growth-board">
      <h3 className="growth-board__title">{title}</h3>
      <p className="growth-board__caption">{caption}</p>
      <div className="growth-board__scroll">
        <table className="growth-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Creator</th>
              <th scope="col">Followers</th>
              <th scope="col">{metric === 'absolute' ? 'Gained' : 'Growth'}</th>
              <th scope="col">Trend</th>
              <th scope="col">Posts</th>
              <th scope="col">Best</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="growth-table__empty">
                  Nothing captured yet.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const value = metric === 'absolute' ? r.gained : r.percent
              return (
                <tr key={r.author_id}>
                  <td>{r.rank}</td>
                  <td>
                    <button type="button" className="growth-name" onClick={() => onSelect(r)}>
                      {r.display_name ?? r.author_id}
                    </button>
                    {r.stale && (
                      <span className="growth-stale" title="Last captured more than a day ago — this number is last known, not current">
                        stale
                      </span>
                    )}
                  </td>
                  <td>{nf.format(r.followers)}</td>
                  <td
                    className={deltaClass(value)}
                    {...(r.approx
                      ? { title: 'Baseline is older than the window — this gain accumulated over longer than the selected window' }
                      : {})}
                  >
                    {r.approx && value !== null ? '~' : ''}
                    {metric === 'absolute' ? signed(r.gained) : signedPct(r.percent)}
                  </td>
                  <td className="growth-table__spark">
                    <Sparkline points={r.spark} />
                  </td>
                  <td>{r.posts}</td>
                  <td>{r.best_x_score === null ? '—' : `${r.best_x_score.toFixed(1)}σ`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function GrowthBoard(): JSX.Element {
  const [windowDays, setWindowDays] = useState<Window>(1)
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [capture, setCapture] = useState<Capture>({ status: 'idle' })
  const [selected, setSelected] = useState<BoardRow | null>(null)

  const load = useCallback((w: Window) => {
    setError(null)
    apiFetch<Leaderboard>(`/api/followers?window=${w}`)
      .then(setBoard)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load the leaderboard'))
  }, [])

  useEffect(() => load(windowDays), [load, windowDays])

  async function runCapture(): Promise<void> {
    setCapture({ status: 'running' })
    try {
      const res = await apiFetch<{ captured: number; requested: number }>('/api/followers/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      setCapture({ status: 'done', captured: res.captured, requested: res.requested })
      load(windowDays)
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 412) {
        const needs = ((e as { body?: { needs?: string[] } }).body?.needs ?? []) as string[]
        setCapture({ status: 'blocked', needs })
      } else {
        setCapture({ status: 'failed', error: e instanceof Error ? e.message : 'Capture failed' })
      }
    }
  }

  return (
    <div className="growth">
      <header className="growth__header">
        <div>
          <h2>Champion leaderboard</h2>
          {board && (
            <p className="growth__meta">
              As of {board.as_of} · captured {board.coverage.measured} of {board.coverage.creators} creators
            </p>
          )}
        </div>
        <div className="growth__controls">
          <div className="growth__windows" role="group" aria-label="Leaderboard window">
            {WINDOWS.map((w) => (
              <button key={w} type="button" aria-pressed={windowDays === w} onClick={() => setWindowDays(w)}>
                {w}d
              </button>
            ))}
          </div>
          <button type="button" className="growth__capture" onClick={runCapture} disabled={capture.status === 'running'}>
            {capture.status === 'running' ? 'Capturing…' : 'Capture today'}
          </button>
        </div>
      </header>

      {error && (
        <p className="growth__error" role="alert">
          Couldn’t load the leaderboard: {error}
        </p>
      )}
      {capture.status === 'failed' && (
        <p className="growth__error" role="alert">
          Capture failed: {capture.error}
        </p>
      )}
      {capture.status === 'blocked' && (
        <p className="growth__error" role="alert">
          Add your {capture.needs.join(', ')} in Settings before capturing.
        </p>
      )}
      {capture.status === 'done' && (
        <p className="growth__note">
          Captured {capture.captured} of {capture.requested} creators.
        </p>
      )}

      <TrackedCreatorPicker onChanged={() => load(windowDays)} />

      {board && (
        <div className="growth__boards">
          <Board
            title="Most followers gained"
            caption={`Every creator, ranked by followers added over ${board.window_days}d.`}
            rows={board.absolute}
            metric="absolute"
            onSelect={setSelected}
          />
          <Board
            title="Fastest % growth"
            caption={`Rate over ${board.window_days}d, ${nf.format(board.percent_floor)}+ followers only — smaller accounts swing on noise.`}
            rows={board.percent}
            metric="percent"
            onSelect={setSelected}
          />
        </div>
      )}

      <PostGrowthBoard />

      {selected && (
        <CreatorGrowthPanel
          key={selected.author_id}
          authorId={selected.author_id}
          displayName={selected.display_name}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
