'use client'
// Layer 6 — ScrapeHistory (PRD §11.5 Screen B, §11.6): the last 20 scrape runs from scrape_jobs.
// Read-only. Fetched = keyword_raw + creator_raw; New = inserted.

import { useEffect, useState } from 'react'

interface JobRow {
  id: string
  status: string
  mode: string
  platforms: string // JSON array
  params: string | null // JSON
  keyword_raw: number
  creator_raw: number
  inserted: number
  started_at: string
}

const parseArr = (json: string | null): string[] => {
  if (!json) return []
  try {
    return JSON.parse(json) as string[]
  } catch {
    return []
  }
}
const platformLabel = (json: string): string => {
  const p = parseArr(json)
  return p.length > 1 ? 'All' : (p[0] ?? '—')
}
const keywordsLabel = (json: string | null): string => {
  try {
    const kws = (json ? (JSON.parse(json) as { keywords?: string[] }).keywords : []) ?? []
    return kws.length ? kws.join(', ') : '—'
  } catch {
    return '—'
  }
}
const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

export function ScrapeHistory() {
  const [jobs, setJobs] = useState<JobRow[]>([])

  useEffect(() => {
    void fetch('/api/scrape/history')
      .then((r) => r.json())
      .then((b: { jobs: JobRow[] }) => setJobs(b.jobs))
  }, [])

  return (
    <section className="history" aria-label="scrape history">
      <h3>Scrape History</h3>
      {jobs.length === 0 ? (
        <p className="placeholder">No scrapes yet.</p>
      ) : (
        <table className="history__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Source</th>
              <th>Platform</th>
              <th>Keywords</th>
              <th>Fetched</th>
              <th>New</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{when(j.started_at)}</td>
                <td>{j.mode}</td>
                <td>{platformLabel(j.platforms)}</td>
                <td>{keywordsLabel(j.params)}</td>
                <td>{j.keyword_raw + j.creator_raw}</td>
                <td>{j.inserted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
