// Temporary tab: "Apify vs AssemblyAI" side-by-side Instagram research demo. Self-contained under
// lib/ig-compare/ + app/api/ig-compare/ + app/IgCompare.tsx so it can be removed in one pass later.

// The exact same array of these gets passed to both transcription routes, so both panels provably
// research the identical post set, not two independent re-scrapes.
export interface DiscoveredPost {
  shortCode: string
  postUrl: string
  videoUrl: string
  thumbnail: string | null
  caption: string | null
}

export interface DiscoverResponse {
  elapsedMs: number
  estimatedCostUsd: number
  posts: DiscoveredPost[]
}

export interface ClipResult {
  shortCode: string
  postUrl: string
  thumbnail: string | null
  caption: string | null
  transcript: string
  sentiments?: { text: string; sentiment: string; confidence: number }[]
  audioDurationSec?: number
}

export type ResearchMethod = 'apify-whisper' | 'assemblyai'

export interface ResearchResponse {
  method: ResearchMethod
  postCount: number
  elapsedMs: number
  estimatedCostUsd: number
  clips: ClipResult[]
}
