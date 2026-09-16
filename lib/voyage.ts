// Layer 2 — Voyage embeddings adapter (PRD §7, §12 step 18).
// Reads voyage_api_key from settings (BYO); throws clearly when unset. Batches text at 100.
// Never logs the key.

import {
  EMBEDDING_BATCH_SIZE,
  IMAGE_EMBEDDING_MODEL,
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  TEXT_EMBEDDING_MODEL,
  VOYAGE_MULTIMODAL_URL,
  VOYAGE_TEXT_URL,
} from '@/lib/config'
import { fetchWithTimeout } from '@/lib/http'
import { getKey } from '@/lib/settings'

function requireKey(): string {
  const key = getKey('voyage_api_key')
  if (!key) {
    throw new Error('Voyage API key is not set — add it in Settings before enriching.')
  }
  return key
}

const EMBED_TIMEOUT_MS = 60_000 // per-request timeout so a hung embed batch can't wedge enrich (PRD §10.7)
const IMAGE_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

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
    const res = await fetchWithTimeout(
      VOYAGE_TEXT_URL,
      {
        method: 'POST',
        headers: authHeaders(key),
        body: JSON.stringify({ input: batch, model: TEXT_EMBEDDING_MODEL }),
      },
      EMBED_TIMEOUT_MS,
    )
    if (!res.ok) {
      throw new Error(`Voyage: text embedding batch failed (${res.status})`)
    }
    const json = (await res.json()) as { data?: { embedding?: unknown; index?: number }[] }
    if (!Array.isArray(json.data)) {
      throw new Error('Voyage: malformed text embedding response (no data array)')
    }
    const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    for (const d of ordered) {
      if (!Array.isArray(d.embedding)) {
        throw new Error('Voyage: malformed text embedding response (missing embedding)')
      }
      out.push(d.embedding as number[])
    }
  }

  return out
}

/**
 * Download an image and return it as a `data:` url.
 *
 * Why we fetch it ourselves instead of handing Voyage the url: LinkedIn's CDN blocks Voyage's
 * server-side fetcher. It answers 400 "The image URL you have provided is invalid" even for urls
 * that are signed, unexpired, and return 200 to this machine — so the url path embedded nothing at
 * all from LinkedIn, which is ~99% of the corpus's images.
 *
 * The url comes from scraped data, and this fetch runs server-side, so the scheme is checked the
 * same way `safeHref` checks one before rendering it: http(s) only, never file:/data:.
 */
async function fetchImageAsDataUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Voyage: refusing to fetch a non-http(s) image url (${url.slice(0, 40)})`)
  }
  // A browser-ish UA: some CDNs answer 403 to a bare fetch for an otherwise public image.
  const res = await fetchWithTimeout(
    url,
    { headers: { 'user-agent': IMAGE_FETCH_USER_AGENT, accept: 'image/*' } },
    IMAGE_FETCH_TIMEOUT_MS,
  )
  // Distinct from a Voyage failure on purpose: 403/404 here means the signed url expired and only a
  // re-scrape can mint a new one, which is a different fix from "the embedder is down".
  if (!res.ok) throw new Error(`Voyage: image fetch failed (${res.status}) for ${url.slice(0, 60)}`)

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
  if (!contentType.startsWith('image/')) {
    throw new Error(`Voyage: not an image (content-type '${contentType || 'none'}')`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Voyage: image too large (${bytes.length} bytes > ${MAX_IMAGE_BYTES})`)
  }
  return `data:${contentType};base64,${bytes.toString('base64')}`
}

/** Embed a single image with voyage-multimodal-3, sending the bytes inline (see above). */
export async function embedImage(url: string): Promise<number[]> {
  const key = requireKey() // before the download, so a missing key costs no bandwidth
  const dataUrl = await fetchImageAsDataUrl(url)
  const res = await fetchWithTimeout(
    VOYAGE_MULTIMODAL_URL,
    {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({
        inputs: [{ content: [{ type: 'image_base64', image_base64: dataUrl }] }],
        model: IMAGE_EMBEDDING_MODEL,
      }),
    },
    EMBED_TIMEOUT_MS,
  )
  if (!res.ok) {
    throw new Error(`Voyage: image embedding failed (${res.status})`)
  }
  const json = (await res.json()) as { data?: { embedding?: unknown }[] }
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding)) {
    throw new Error('Voyage: malformed image embedding response (missing embedding)')
  }
  return embedding as number[]
}
