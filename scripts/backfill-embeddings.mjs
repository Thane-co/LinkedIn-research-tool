#!/usr/bin/env node
// Backfill text (and optionally image) embeddings for posts the enrich-on-scrape step never covered.
//
//   node scripts/backfill-embeddings.mjs                    # last 30 days, LinkedIn only (default)
//   node scripts/backfill-embeddings.mjs --days 30 --platform linkedin
//   node scripts/backfill-embeddings.mjs --all              # THE WHOLE CORPUS, text only
//   node scripts/backfill-embeddings.mjs --all --images     # ...and image embeddings too (slow)
//   node scripts/backfill-embeddings.mjs --all --dry-run    # count + cost, spend nothing
//
// Safe to interrupt and re-run: it always re-queries for "still missing," never re-embeds a post
// that already succeeded (mirrors enrichPosts' own "never re-embed" contract). A batch that fails
// after its retries is left for the next run rather than aborting the pass.
//
// MODEL LOCK-IN: this must keep using the SAME model (and the same input_type) as every vector
// already in the db. Vectors from two different models are not comparable — cosine similarity
// between them is noise — so switching models means re-embedding all 89k posts, not just the gap.
// input_type is deliberately left UNSET, matching lib/voyage.ts and the existing stored vectors.

import { loadDatabase } from './_load-sqlite.mjs'

const Database = await loadDatabase()
const DB_PATH = process.env.DB_PATH ?? './research.db'
const db = new Database(DB_PATH) // NOT readonly — this writes embeddings back.

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const ALL = flag('--all')
const DRY_RUN = flag('--dry-run')
const DO_IMAGES = ALL ? flag('--images') : true // the scoped run has always done images
const DAYS = Number(value('--days', 30))
const PLATFORM = value('--platform', 'linkedin')

const TEXT_BATCH_SIZE = 100 // Voyage accepts up to 1000; 100 matches EMBEDDING_BATCH_SIZE in config.ts
// Second batching bound. Voyage caps TOTAL tokens per request, and the count bound alone doesn't
// respect it: the average post is ~230 tokens but the longest is ~6.2k, so 100 long posts in one
// batch would be ~620k tokens and a hard 400. Chars/3 deliberately OVER-estimates tokens (English
// is nearer 4) so the margin is on the safe side.
const MAX_BATCH_CHARS = 270_000 // ~90k estimated tokens
// Voyage takes ~30s to answer a 100-post batch, so throughput is bound by CONCURRENCY, not by the
// rate limits: 12 in flight is ~530k tokens/min against a 3M/min ceiling and ~24 RPM against 2000.
// Raise with --concurrency N if the limits ever move; the 429 backoff below is the safety net.
const CONCURRENCY = Number(value('--concurrency', 12))
const MAX_ATTEMPTS = 5
const USD_PER_MILLION_TOKENS = 0.06 // voyage-3, docs.voyageai.com/docs/pricing (Sep 2026)

const VOYAGE_TEXT_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MULTIMODAL_URL = 'https://api.voyageai.com/v1/multimodalembeddings'
const TEXT_MODEL = 'voyage-3'
const IMAGE_MODEL = 'voyage-multimodal-3'
const EMBED_TIMEOUT_MS = 60_000

const key = db.prepare("SELECT value FROM settings WHERE key = 'voyage_api_key'").get()?.value
if (!key) {
  console.error('No voyage_api_key in settings. Set it in the app before running this.')
  process.exit(1)
}

function vectorToBlob(vec) {
  const buf = Buffer.allocUnsafe(vec.length * 4)
  vec.forEach((v, i) => buf.writeFloatLE(v, i * 4))
  return buf
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Retryable = rate limited (429) or a transient server fault (5xx). A 4xx is our bug; don't spin. */
const isRetryable = (status) => status === 429 || (status >= 500 && status < 600)

/**
 * How long to wait before attempt n. Honors Retry-After when the server sends one (it knows better
 * than we do), else exponential backoff with jitter so parallel workers don't retry in lockstep.
 */
function backoffMs(res, attempt) {
  const header = res?.headers?.get?.('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000)
  }
  return Math.min(1000 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  })
}

/** One text batch, with retries. Throws only once the retries are exhausted or the error is ours. */
async function embedTextBatch(texts) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res
    try {
      res = await postJson(VOYAGE_TEXT_URL, { input: texts, model: TEXT_MODEL })
    } catch (err) {
      // Network error / timeout: retryable, same backoff ladder.
      if (attempt === MAX_ATTEMPTS) throw err
      await sleep(backoffMs(null, attempt))
      continue
    }
    if (res.ok) {
      const json = await res.json()
      if (!Array.isArray(json.data)) throw new Error('malformed text embedding response (no data array)')
      return [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
    }
    const detail = await res.text().catch(() => '')
    if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`Voyage ${res.status}: ${detail.slice(0, 200)}`)
    }
    const wait = backoffMs(res, attempt)
    console.warn(`[text] ${res.status} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})`)
    await sleep(wait)
  }
  throw new Error('unreachable')
}

const IMAGE_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const MAX_IMAGE_BYTES = 8_000_000

/**
 * Download the image and return it as a data: url — mirrors lib/voyage.ts.
 *
 * Voyage's own server-side fetcher is blocked by LinkedIn's CDN: it answers 400 "the image URL you
 * have provided is invalid" even for urls that are signed, unexpired, and serve a 200 to this
 * machine. Handing it the url embedded nothing from LinkedIn; sending the bytes works.
 */
async function fetchImageAsDataUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('non-http(s) image url')
  const res = await fetch(url, {
    headers: { 'user-agent': IMAGE_FETCH_USER_AGENT, accept: 'image/*' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`image fetch failed (${res.status})`)
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!contentType.startsWith('image/')) throw new Error(`not an image (${contentType || 'none'})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${bytes.length})`)
  return `data:${contentType};base64,${bytes.toString('base64')}`
}

async function embedImage(url) {
  const dataUrl = await fetchImageAsDataUrl(url)
  const res = await postJson(VOYAGE_MULTIMODAL_URL, {
    inputs: [{ content: [{ type: 'image_base64', image_base64: dataUrl }] }],
    model: IMAGE_MODEL,
  })
  if (!res.ok) throw new Error(`Voyage image embed failed: ${res.status}`)
  const json = await res.json()
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding)) throw new Error('malformed image embedding response')
  return embedding
}

/**
 * Expiry of a signed CDN url, or null when it carries none.
 *
 * LinkedIn serves images from media.licdn.com behind a signature: `?e=<unix-seconds>&v=beta&t=<sig>`.
 * Once `e` has passed the url is a permanent 403 — the image is not coming back without re-scraping
 * the post to mint a fresh url. 86% of this corpus's pending images are already in that state, so
 * checking the timestamp locally turns a ~40k-request run (99% of it failing) into a ~5.7k one.
 */
function signedUrlExpiry(url) {
  const match = /[?&]e=(\d+)/.exec(url ?? '')
  return match ? Number(match[1]) * 1000 : null
}

/** Provably dead: signed, and the signature's expiry is in the past. Never worth a request. */
function isExpiredUrl(url) {
  const expiry = signedUrlExpiry(url)
  return expiry !== null && expiry <= Date.now()
}

const buildEmbeddingText = (content, imgDesc) => {
  const base = (content ?? '').trim()
  return imgDesc ? `${base}\n\n[Image content: ${imgDesc}]` : base
}

/** Split rows into batches bounded by BOTH the row count and the estimated token count. */
function buildBatches(rows) {
  const batches = []
  let current = []
  let chars = 0
  for (const row of rows) {
    const size = row.text.length
    // A single row over the cap still goes out alone — Voyage truncates at the context limit.
    if (current.length > 0 && (current.length >= TEXT_BATCH_SIZE || chars + size > MAX_BATCH_CHARS)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(row)
    chars += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

// --- Phase 1: text embeddings ----------------------------------------------------------------

// An empty/whitespace-only post has nothing to embed: Voyage rejects an empty string, and one such
// row would fail the whole batch around it.
const scope = ALL
  ? { sql: "WHERE embedding IS NULL AND content IS NOT NULL AND trim(content) <> ''", params: [] }
  : {
      sql: `WHERE platform = ? AND posted_at >= ? AND embedding IS NULL
            AND content IS NOT NULL AND trim(content) <> ''`,
      params: [PLATFORM, new Date(Date.now() - DAYS * 86400000).toISOString()],
    }

const needText = db
  .prepare(`SELECT id, content, image_description FROM posts ${scope.sql}`)
  .all(...scope.params)
  .map((p) => ({ id: p.id, text: buildEmbeddingText(p.content, p.image_description) }))

const totalChars = needText.reduce((n, r) => n + r.text.length, 0)
const estTokens = Math.round(totalChars / 4) // ~4 chars/token in English, for the cost estimate
const estCost = (estTokens / 1_000_000) * USD_PER_MILLION_TOKENS
const batches = buildBatches(needText)

console.log(`\nScope: ${ALL ? 'ENTIRE CORPUS' : `${PLATFORM}, last ${DAYS} days`}`)
console.log(`[text] ${needText.length.toLocaleString()} posts need text embeddings`)
console.log(`[text] ${batches.length} batches · ~${estTokens.toLocaleString()} tokens · ~$${estCost.toFixed(2)} on ${TEXT_MODEL}`)

if (DRY_RUN) {
  const largest = batches.reduce((m, b) => Math.max(m, b.reduce((n, r) => n + r.text.length, 0)), 0)
  console.log(`[text] largest batch ~${Math.round(largest / 4).toLocaleString()} tokens (request cap is well above this)`)
  console.log('\nDry run — nothing sent, nothing spent.\n')
  db.close()
  process.exit(0)
}

const writeBatch = db.transaction((batch, vectors, now) => {
  const stmt = db.prepare('UPDATE posts SET embedding = ?, embedded_at = ? WHERE id = ?')
  batch.forEach((row, j) => stmt.run(vectorToBlob(vectors[j]), now, row.id))
})

let textDone = 0
let textFailed = 0
const startedAt = Date.now()

await pool(batches, CONCURRENCY, async (batch) => {
  try {
    const vectors = await embedTextBatch(batch.map((r) => r.text))
    writeBatch(batch, vectors, new Date().toISOString())
    textDone += batch.length
  } catch (err) {
    textFailed += batch.length
    console.error(`[text] batch of ${batch.length} failed: ${err.message} — left for the next run`)
  }
  const done = textDone + textFailed
  if (done % 2000 < batch.length || done === needText.length) {
    const rate = done / ((Date.now() - startedAt) / 1000)
    const eta = rate > 0 ? Math.round((needText.length - done) / rate) : 0
    console.log(
      `[text] ${done.toLocaleString()}/${needText.length.toLocaleString()} · ${Math.round(rate)}/s · ETA ${Math.floor(eta / 60)}m${eta % 60}s`,
    )
  }
})

// --- Phase 2: image embeddings (sequential — the multimodal endpoint takes one image per call) ---

let imageDone = 0
let imageFailed = 0
let needImage = []

if (DO_IMAGES) {
  const imageScope = ALL
    ? { sql: 'WHERE image_url IS NOT NULL AND image_embedding IS NULL', params: [] }
    : {
        sql: `WHERE platform = ? AND posted_at >= ? AND image_url IS NOT NULL AND image_embedding IS NULL`,
        params: [PLATFORM, new Date(Date.now() - DAYS * 86400000).toISOString()],
      }
  const pending = db.prepare(`SELECT id, image_url FROM posts ${imageScope.sql}`).all(...imageScope.params)
  needImage = pending.filter((p) => !isExpiredUrl(p.image_url))
  const expiredCount = pending.length - needImage.length

  console.log(`\n[image] ${pending.length.toLocaleString()} posts pending an image embedding.`)
  if (expiredCount > 0) {
    console.log(
      `[image] ${expiredCount.toLocaleString()} skipped: their signed CDN url has already expired ` +
        '(permanent 403 — only a re-scrape can mint a fresh one).',
    )
  }
  console.log(`[image] attempting ${needImage.length.toLocaleString()}.`)

  const imageStart = Date.now()
  const writeImage = db.prepare('UPDATE posts SET image_embedding = ? WHERE id = ?')
  // Concurrent, like the text phase: the multimodal endpoint takes one image per call, so serially
  // this would be hours. Voyage fetches each url server-side, and a dead one costs nothing.
  await pool(needImage, CONCURRENCY, async (post) => {
    try {
      const vec = await embedImage(post.image_url)
      writeImage.run(vectorToBlob(vec), post.id)
      imageDone++
    } catch {
      imageFailed++
      // Non-fatal by design (mirrors jobs/enrich.ts) — one bad/expired image url can't stall the run.
    }
    const done = imageDone + imageFailed
    if (done % 500 === 0 || done === needImage.length) {
      const rate = done / ((Date.now() - imageStart) / 1000)
      console.log(
        `[image] ${done.toLocaleString()}/${needImage.length.toLocaleString()} · ${imageDone} ok · ${imageFailed} dead · ${Math.round(rate)}/s`,
      )
    }
  })
} else if (ALL) {
  const pending = db
    .prepare('SELECT COUNT(*) n FROM posts WHERE image_url IS NOT NULL AND image_embedding IS NULL')
    .get().n
  console.log(`\n[image] skipped — ${pending.toLocaleString()} pending. Re-run with --images to include them.`)
}

const elapsed = Math.round((Date.now() - startedAt) / 1000)
console.log(`\nDone in ${Math.floor(elapsed / 60)}m${elapsed % 60}s.`)
console.log(`  text:  ${textDone.toLocaleString()} embedded, ${textFailed.toLocaleString()} failed`)
if (DO_IMAGES) {
  console.log(`  image: ${imageDone.toLocaleString()} embedded, ${imageFailed.toLocaleString()} unreachable`)
}
if (textFailed > 0) console.log('\nRe-run the same command to pick up what failed.')
db.close()
