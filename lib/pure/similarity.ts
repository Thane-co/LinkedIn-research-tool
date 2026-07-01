// Layer 0 — cosine & combined similarity (PRD §9.1). Zero I/O. 100% coverage required.
// Dimension-agnostic so tests can use tiny 4-dim vectors.

import { IMAGE_WEIGHT, TEXT_WEIGHT } from '@/lib/config'

/** Cosine similarity of two equal-length vectors. Returns 0 if either has zero magnitude. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Combined similarity used by content clustering: when both posts have image embeddings,
 * TEXT_WEIGHT*cosine(text) + IMAGE_WEIGHT*cosine(image); otherwise text-only cosine.
 */
export function combined(
  p: { textEmbedding: number[]; imageEmbedding: number[] | null },
  q: { textEmbedding: number[]; imageEmbedding: number[] | null },
): number {
  const textSim = cosine(p.textEmbedding, q.textEmbedding)
  if (p.imageEmbedding && q.imageEmbedding) {
    return TEXT_WEIGHT * textSim + IMAGE_WEIGHT * cosine(p.imageEmbedding, q.imageEmbedding)
  }
  return textSim
}
