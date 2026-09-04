'use client'
// Temporary tab: side-by-side "Apify vs AssemblyAI" comparison. Researches a creator's Instagram
// video posts from the last 7 days two ways and shows time/cost landing live for that run.
// Left = AssemblyAI (one direct call per clip, transcript + sentiment together, fills in as each
// clip lands). Right = Apify (the production pipeline: post-scraper + crawlerbros transcript
// actor, one batched run, nothing lands until the whole run finishes).
// Self-contained with lib/ig-compare/* + app/api/ig-compare/* — safe to delete as one unit later.

import { useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { discoveryCost, formatMs, formatUsd } from '@/lib/ig-compare/pricing'
import type { ClipResult, DiscoveredPost, ResearchResponse } from '@/lib/ig-compare/types'
import type { AfterClipResponse } from './api/ig-compare/after/route'

interface DiscoverState {
  loading: boolean
  elapsedMs: number
  posts: DiscoveredPost[] | null
  error: string | null
}
const EMPTY_DISCOVER: DiscoverState = { loading: false, elapsedMs: 0, posts: null, error: null }

// The Apify pipeline is one batched actor run in reality — nothing comes back until the whole
// batch finishes, so all its clips land at once.
interface ApifyState {
  loading: boolean
  elapsedMs: number
  result: ResearchResponse | null
  error: string | null
}
const EMPTY_APIFY: ApifyState = { loading: false, elapsedMs: 0, result: null, error: null }

// AssemblyAI is genuinely one independent call per clip, so clips are tracked by shortCode and
// filled in one at a time as each call resolves.
interface AssemblyState {
  loading: boolean
  elapsedMs: number
  totalCostUsd: number
  clipsByCode: Record<string, ClipResult>
  errorsByCode: Record<string, string>
}
const EMPTY_ASSEMBLY: AssemblyState = { loading: false, elapsedMs: 0, totalCostUsd: 0, clipsByCode: {}, errorsByCode: {} }

interface ClipSlot {
  post: DiscoveredPost
  clip: ClipResult | null
  error?: string
}

function buildSlots(posts: DiscoveredPost[], clipsByCode: Record<string, ClipResult>): ClipSlot[] {
  return posts.map((post) => ({ post, clip: clipsByCode[post.shortCode] ?? null }))
}

function ClipCard({ slot }: { slot: ClipSlot }) {
  const { post, clip, error } = slot
  return (
    <div className="igc-clip">
      {post.thumbnail && <img src={post.thumbnail} alt="" />}
      {!clip && !error && <p className="igc-transcript igc-transcript--pending">transcribing…</p>}
      {error && (
        <p className="igc-error" role="alert">
          {error}
        </p>
      )}
      {clip && (
        <>
          <p className={`igc-transcript${clip.transcript ? '' : ' igc-transcript--empty'}`}>
            {clip.transcript || '(no speech detected)'}
          </p>
          {clip.sentiments && clip.sentiments.length > 0 && (
            <div className="igc-sentiments">
              {clip.sentiments.map((s, i) => (
                <span key={i} className={`igc-tag igc-tag--${s.sentiment.toLowerCase()}`}>
                  {s.sentiment}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Panel({
  title,
  subtitle,
  posts,
  elapsedMs,
  costUsd,
  doneCount,
  totalCount,
  panelError,
  slots,
}: {
  title: string
  subtitle: string
  posts: DiscoveredPost[]
  elapsedMs: number
  costUsd: number | null
  doneCount: number
  totalCount: number
  panelError: string | null
  slots: ClipSlot[]
}) {
  const done = totalCount > 0 && doneCount === totalCount
  const valueClass = `igc-value${done ? ' igc-value--done' : ''}`

  return (
    <div className="igc-panel">
      <h3>{title}</h3>
      <p className="igc-subtitle">{subtitle}</p>

      <div className="igc-stats">
        <div>
          <span className="igc-label">Time</span>
          <span className={valueClass}>{formatMs(elapsedMs)}</span>
        </div>
        <div>
          <span className="igc-label">Cost</span>
          <span className={valueClass}>{costUsd !== null ? formatUsd(costUsd) : '—'}</span>
        </div>
        <div>
          <span className="igc-label">Clips</span>
          <span className={valueClass}>{totalCount > 0 ? `${doneCount}/${totalCount}` : '—'}</span>
        </div>
      </div>

      {panelError && (
        <p className="igc-error" role="alert">
          {panelError}
        </p>
      )}
      {posts.length === 0 && <p className="igc-status">Waiting on posts to research…</p>}

      <div className="igc-clips">
        {slots.map((slot) => (
          <ClipCard key={slot.post.shortCode} slot={slot} />
        ))}
      </div>
    </div>
  )
}

export function IgCompare({ ready }: { ready: { apify: boolean; assemblyai: boolean } }) {
  const [username, setUsername] = useState('')
  const [limit, setLimit] = useState(5)
  const [discover, setDiscover] = useState<DiscoverState>(EMPTY_DISCOVER)
  const [apify, setApify] = useState<ApifyState>(EMPTY_APIFY)
  const [assembly, setAssembly] = useState<AssemblyState>(EMPTY_ASSEMBLY)

  const gated = !ready.apify || !ready.assemblyai

  function runApify(posts: DiscoveredPost[]) {
    setApify({ loading: true, elapsedMs: 0, result: null, error: null })
    const start = Date.now()
    const timer = window.setInterval(() => {
      setApify((s) => (s.loading ? { ...s, elapsedMs: Date.now() - start } : s))
    }, 100)

    apiFetch<ResearchResponse>('/api/ig-compare/before', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ posts }),
    })
      .then((json) => {
        window.clearInterval(timer)
        setApify({ loading: false, elapsedMs: json.elapsedMs, result: json, error: null })
      })
      .catch((err) => {
        window.clearInterval(timer)
        setApify({ loading: false, elapsedMs: Date.now() - start, result: null, error: (err as Error).message })
      })
  }

  function runAssembly(posts: DiscoveredPost[]) {
    setAssembly({ loading: true, elapsedMs: 0, totalCostUsd: 0, clipsByCode: {}, errorsByCode: {} })
    const start = Date.now()
    const timer = window.setInterval(() => {
      setAssembly((s) => (s.loading ? { ...s, elapsedMs: Date.now() - start } : s))
    }, 100)

    let settled = 0
    const stopIfDone = () => {
      settled += 1
      if (settled >= posts.length) {
        window.clearInterval(timer)
        setAssembly((s) => ({ ...s, loading: false, elapsedMs: Date.now() - start }))
      }
    }

    posts.forEach((post) => {
      apiFetch<AfterClipResponse>('/api/ig-compare/after', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ post }),
      })
        .then(({ clip, estimatedCostUsd }) => {
          setAssembly((s) => ({
            ...s,
            totalCostUsd: s.totalCostUsd + estimatedCostUsd,
            clipsByCode: { ...s.clipsByCode, [post.shortCode]: clip },
          }))
        })
        .catch((err) => {
          setAssembly((s) => ({ ...s, errorsByCode: { ...s.errorsByCode, [post.shortCode]: (err as Error).message } }))
        })
        .finally(stopIfDone)
    })
  }

  async function run() {
    setDiscover({ loading: true, elapsedMs: 0, posts: null, error: null })
    setApify(EMPTY_APIFY)
    setAssembly(EMPTY_ASSEMBLY)

    const start = Date.now()
    const timer = window.setInterval(() => {
      setDiscover((d) => (d.loading ? { ...d, elapsedMs: Date.now() - start } : d))
    }, 100)

    let posts: DiscoveredPost[]
    try {
      const json = await apiFetch<{ elapsedMs: number; posts: DiscoveredPost[] }>('/api/ig-compare/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, limit }),
      })
      window.clearInterval(timer)
      posts = json.posts
      setDiscover({ loading: false, elapsedMs: json.elapsedMs, posts, error: null })
    } catch (err) {
      window.clearInterval(timer)
      setDiscover({ loading: false, elapsedMs: Date.now() - start, posts: null, error: (err as Error).message })
      return
    }

    if (posts.length === 0) return
    // Same array, handed to both, so neither panel re-scrapes and both work on the identical posts.
    runAssembly(posts)
    runApify(posts)
  }

  const busy = discover.loading || apify.loading || assembly.loading
  const posts = discover.posts ?? []

  const apifySlots = buildSlots(posts, apify.result ? Object.fromEntries(apify.result.clips.map((c) => [c.shortCode, c])) : {})
  const assemblySlots = buildSlots(posts, assembly.clipsByCode).map((slot) => ({
    ...slot,
    error: assembly.errorsByCode[slot.post.shortCode],
  }))

  return (
    <section className="igc">
      <header className="igc-header">
        <h2>Research: Apify vs AssemblyAI</h2>
        {gated && (
          <div className="igc-gate" role="alert">
            Add your Apify token and AssemblyAI key in Settings to run this comparison.
          </div>
        )}
        <div className="igc-controls">
          <input
            type="text"
            placeholder="Instagram handle, e.g. jessijean"
            value={username}
            onChange={(e) => setUsername(e.target.value.trim())}
            disabled={gated}
          />
          <input
            type="number"
            min={1}
            max={10}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 5)}
            disabled={gated}
          />
          <span>clips from the last 7 days</span>
          <button type="button" className="igc-primary" onClick={run} disabled={gated || busy || !username}>
            {busy ? 'Researching…' : 'Research this week'}
          </button>
        </div>

        {(discover.loading || discover.posts || discover.error) && (
          <div className="igc-discover-bar">
            <span className="igc-discover-label">Finding posts</span>
            <span className="igc-discover-value">{formatMs(discover.elapsedMs)}</span>
            {discover.posts && (
              <>
                <span className="igc-discover-value">{formatUsd(discoveryCost(discover.posts.length))}</span>
                <span className="igc-discover-note">
                  {discover.posts.length} video posts found — same set feeds both panels below
                </span>
              </>
            )}
            {discover.error && (
              <span className="igc-error" role="alert">
                {discover.error}
              </span>
            )}
          </div>
        )}
      </header>

      <div className="igc-grid">
        <Panel
          title="AssemblyAI"
          subtitle="One independent call per clip. Each one lands the moment it's done."
          posts={posts}
          elapsedMs={assembly.elapsedMs}
          costUsd={Object.keys(assembly.clipsByCode).length > 0 || assembly.totalCostUsd > 0 ? assembly.totalCostUsd : null}
          doneCount={Object.keys(assembly.clipsByCode).length}
          totalCount={posts.length}
          panelError={null}
          slots={assemblySlots}
        />
        <Panel
          title="Apify + Whisper"
          subtitle="One batched actor run. Nothing lands until it finishes."
          posts={posts}
          elapsedMs={apify.elapsedMs}
          costUsd={apify.result?.estimatedCostUsd ?? null}
          doneCount={apify.result ? apify.result.clips.length : 0}
          totalCount={posts.length}
          panelError={apify.error}
          slots={apifySlots}
        />
      </div>
    </section>
  )
}
