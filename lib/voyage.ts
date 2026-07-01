// Layer 2 — Voyage embeddings adapter (PRD §7, §12 step 18).
// Reads voyage_api_key from settings (BYO); throws clearly when unset. Batch 100; returns 1024-dim.
// TDD: msw-mock Voyage; batch of 100; error per-batch isolated; returns 1024-len vectors; throws
// clearly when key unset.

/** Embed up to a batch of strings with voyage-3 (1024-dim each). Batches internally at 100. */
export function embedTexts(_texts: string[]): Promise<number[][]> {
  throw new Error('Not implemented — see PRD §7.1/§7.3')
}

/** Embed a single image url with voyage-multimodal-3 (1024-dim). */
export function embedImage(_url: string): Promise<number[]> {
  throw new Error('Not implemented — see PRD §7.1')
}
