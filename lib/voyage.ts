// Layer 2 — Voyage embeddings adapter (PRD §7, §12 step 18).
// Reads voyage_api_key from settings (BYO); throws clearly when unset. Batches text at 100.
// Never logs the key.

import {
  EMBEDDING_BATCH_SIZE,
  IMAGE_EMBEDDING_MODEL,
  TEXT_EMBEDDING_MODEL,
  VOYAGE_MULTIMODAL_URL,
  VOYAGE_TEXT_URL,
} from '@/lib/config'
import { getKey } from '@/lib/settings'

function requireKey(): string {
  const key = getKey('voyage_api_key')
  if (!key) {
    throw new Error('Voyage API key is not set — add it in Settings before enriching.')
  }
  return key
}

const authHeaders = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
})

/** Embed strings with voyage-3. Batches internally at EMBEDDING_BATCH_SIZE; preserves input order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const key = requireKey()
  const out: number[][] = []

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
    const res = await fetch(VOYAGE_TEXT_URL, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({ input: batch, model: TEXT_EMBEDDING_MODEL }),
    })
    if (!res.ok) {
      throw new Error(`Voyage: text embedding batch failed (${res.status})`)
    }
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] }
    const ordered = [...json.data].sort((a, b) => a.index - b.index)
    for (const d of ordered) out.push(d.embedding)
  }

  return out
}

/** Embed a single image url with voyage-multimodal-3. */
export async function embedImage(url: string): Promise<number[]> {
  const key = requireKey()
  const res = await fetch(VOYAGE_MULTIMODAL_URL, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({
      inputs: [{ content: [{ type: 'image_url', image_url: url }] }],
      model: IMAGE_EMBEDDING_MODEL,
    }),
  })
  if (!res.ok) {
    throw new Error(`Voyage: image embedding failed (${res.status})`)
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] }
  return json.data[0]!.embedding
}
