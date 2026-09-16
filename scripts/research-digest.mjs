#!/usr/bin/env node
// Research digest (Step 2 of the Telegram research pipeline).
//
// Runs the 4 discovery queries Basia does manually every ~30 days, merges them, checks each
// candidate against her own posting history (dedupe/refresh), and ranks the result down to 20
// ideas a Telegram bot can hand her.
//
//   node scripts/research-digest.mjs
//   node scripts/research-digest.mjs --json         # machine-readable, for the bot to parse
//   node scripts/research-digest.mjs --goal grow     # override the active editorial-calendar goal
//
// Reuses the same primitives the app itself uses (cosine similarity over Voyage embeddings, the
// same clustering candidate query) so this never drifts from what the UI/API actually compute.

import { loadDatabase } from './_load-sqlite.mjs'

const Database = await loadDatabase()
const DB_PATH = process.env.DB_PATH ?? './research.db'
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const goalFlagIdx = args.indexOf('--goal')
const goalOverride = goalFlagIdx !== -1 ? args[goalFlagIdx + 1] : null

const TIMEFRAME_DAYS = 30
const OWN_AUTHOR_ID = 'basiakubicka'
const RESULT_SIZE = 20
const CANDIDATE_CAP = 400 // matches lib/config.ts CANDIDATE_CAP — keep in sync if that changes
const DUPLICATE_THRESHOLD = 0.85 // cosine sim above this vs a past post of hers = "already posted"
const REFRESH_THRESHOLD = 0.65 // between REFRESH and DUPLICATE = "refresh candidate" (only if her post is 30+ days old)
const REFRESH_MIN_AGE_DAYS = 30

// --- vector helpers (mirrors lib/pure/vector-blob.ts + lib/pure/similarity.ts) --------------------

function blobToVector(buf) {
  if (buf === null) return null
  if (buf.length % 4 !== 0) return null
  const out = new Array(buf.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const sinceIso = (days) => new Date(Date.now() - days * 86400000).toISOString()

// --- 1. load Basia's own posting history (for dedupe/refresh) -------------------------------------

const ownPosts = db
  .prepare(
    `SELECT id, content, posted_at, embedding FROM posts WHERE author_id = ? AND embedding IS NOT NULL`,
  )
  .all(OWN_AUTHOR_ID)
  .map((r) => ({ ...r, vec: blobToVector(r.embedding) }))
  .filter((r) => r.vec !== null)

console.error(`Loaded ${ownPosts.length} of Basia's own posts (with embeddings) for dedupe.`)

function checkAgainstHistory(candidateVec) {
  let best = { sim: 0, post: null }
  for (const p of ownPosts) {
    const sim = cosine(candidateVec, p.vec)
    if (sim > best.sim) best = { sim, post: p }
  }
  if (best.sim >= DUPLICATE_THRESHOLD) {
    return { status: 'posted', similarity: best.sim, matchedPost: best.post }
  }
  if (best.sim >= REFRESH_THRESHOLD) {
    const ageDays = (Date.now() - new Date(best.post.posted_at).getTime()) / 86400000
    if (ageDays >= REFRESH_MIN_AGE_DAYS) {
      return { status: 'refresh_candidate', similarity: best.sim, matchedPost: best.post, ageDays: Math.round(ageDays) }
    }
    return { status: 'recently_covered', similarity: best.sim, matchedPost: best.post, ageDays: Math.round(ageDays) }
  }
  return { status: 'new', similarity: best.sim, matchedPost: null }
}

// --- 2. active goal (from 02-strategy/editorial-calendar.md, or --goal override) -------------------
// Kept intentionally simple for v1: a goal just re-weights x-factor vs raw-likes contribution.
// grow -> favor things that look like they bring new followers (below); sell -> favor comments/shares
// (conversation + intent signal); default -> balanced x-factor.
const GOAL = goalOverride ?? 'balanced'
const GOAL_WEIGHTS = {
  grow: { xfactor: 0.5, likes: 0.2, comments: 0.3 },
  sell: { xfactor: 0.3, likes: 0.2, comments: 0.5 },
  balanced: { xfactor: 0.6, likes: 0.3, comments: 0.1 },
}[GOAL] ?? { xfactor: 0.6, likes: 0.3, comments: 0.1 }

// --- 3. the four discovery queries ----------------------------------------------------------------

const dateFrom = sinceIso(TIMEFRAME_DAYS)

// x_factor is a creator-relative ratio (this post vs that creator's own baseline) — the app already
// nulls it out below MIN_SAMPLE_SIZE (lib/pure/x-factor.ts), but a tiny-baseline creator can still
// produce a huge ratio off a handful of raw likes (e.g. x=24 on 1 like/1 comment). That is a real
// ratio, not a data bug, but it is useless as a "write about this" signal, so this floor requires
// some minimum absolute engagement before x-factor alone is allowed to rank a post highly.
const MIN_ABSOLUTE_LIKES_FOR_XFACTOR = 20

function queryTopXFactor(limit = 30) {
  return db
    .prepare(
      `SELECT id, content, author_name, author_id, likes, comments, shares, posted_at, x_factor, image_url, embedding
       FROM posts
       WHERE platform = 'linkedin' AND posted_at >= ? AND author_id != ? AND x_factor IS NOT NULL AND likes >= ?
       ORDER BY x_factor DESC LIMIT ?`,
    )
    .all(dateFrom, OWN_AUTHOR_ID, MIN_ABSOLUTE_LIKES_FOR_XFACTOR, limit)
}

function queryTopLikes(limit = 30) {
  return db
    .prepare(
      `SELECT id, content, author_name, author_id, likes, comments, shares, posted_at, x_factor, image_url, embedding
       FROM posts
       WHERE platform = 'linkedin' AND posted_at >= ? AND author_id != ?
       ORDER BY likes DESC LIMIT ?`,
    )
    .all(dateFrom, OWN_AUTHOR_ID, limit)
}

function getCandidatesForClustering(requireImage) {
  const extra = requireImage ? 'image_embedding IS NOT NULL' : 'embedding IS NOT NULL'
  return db
    .prepare(
      `SELECT id, content, author_name, author_id, likes, comments, shares, posted_at, x_factor,
              image_url, image_description, embedding, image_embedding
       FROM posts
       WHERE platform = 'linkedin' AND posted_at >= ? AND author_id != ? AND ${extra}
       ORDER BY likes DESC LIMIT ?`,
    )
    .all(dateFrom, OWN_AUTHOR_ID, CANDIDATE_CAP)
    .map((r) => ({ ...r, textVec: blobToVector(r.embedding), imageVec: blobToVector(r.image_embedding) }))
}

function findGroups(candidates, vecKey, threshold, minSize = 2) {
  const used = new Set()
  const groups = []
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue
    const seed = candidates[i]
    if (!seed[vecKey]) continue
    const members = [seed]
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(j)) continue
      const cand = candidates[j]
      if (!cand[vecKey]) continue
      if (cosine(seed[vecKey], cand[vecKey]) >= threshold) {
        members.push(cand)
        used.add(j)
      }
    }
    if (members.length >= minSize) {
      used.add(i)
      groups.push(members)
    }
  }
  return groups
}

console.error('Querying: top x-factor (30d)...')
const xfactorPosts = queryTopXFactor()
console.error('Querying: top likes (30d)...')
const likesPosts = queryTopLikes()
console.error('Querying: image groups (30d)...')
const imageCandidates = getCandidatesForClustering(true)
const imageGroups = findGroups(imageCandidates, 'imageVec', 0.8)
console.error('Querying: topic clusters (30d)...')
const textCandidates = getCandidatesForClustering(false)
const topicGroups = findGroups(textCandidates, 'textVec', 0.65)

// --- 4. merge into one candidate pool, tagging which query(ies) surfaced each idea -----------------

const pool = new Map() // id -> { post, sources: Set, groupSize }

function addToPool(post, source, groupSize = 1) {
  const existing = pool.get(post.id)
  if (existing) {
    existing.sources.add(source)
    existing.groupSize = Math.max(existing.groupSize, groupSize)
  } else {
    pool.set(post.id, { post, sources: new Set([source]), groupSize })
  }
}

for (const p of xfactorPosts) addToPool(p, 'xfactor')
for (const p of likesPosts) addToPool(p, 'likes')
for (const group of imageGroups) {
  const rep = group.reduce((a, b) => (b.likes > a.likes ? b : a))
  addToPool(rep, 'image_group', group.length)
}
for (const group of topicGroups) {
  const rep = group.reduce((a, b) => (b.likes > a.likes ? b : a))
  addToPool(rep, 'topic_cluster', group.length)
}

console.error(`Merged pool: ${pool.size} distinct candidates from 4 queries.`)

// --- 5. dedupe against Basia's own history, score, rank ---------------------------------------------

const scored = []
for (const { post, sources, groupSize } of pool.values()) {
  const vec = blobToVector(post.embedding)
  const history = vec ? checkAgainstHistory(vec) : { status: 'unknown', similarity: 0, matchedPost: null }

  // Base score: goal-weighted engagement signal.
  const xfactorScore = post.x_factor ?? 0
  const likesScore = post.likes ?? 0
  const commentsScore = post.comments ?? 0
  let score =
    GOAL_WEIGHTS.xfactor * xfactorScore +
    GOAL_WEIGHTS.likes * Math.log1p(likesScore) +
    GOAL_WEIGHTS.comments * Math.log1p(commentsScore)

  // Cross-query overlap is a strength signal (multiple lenses agree) — small deliberate boost.
  score *= 1 + 0.15 * (sources.size - 1)
  // Cluster size is a "this topic has legs" signal.
  score *= 1 + 0.05 * Math.min(groupSize - 1, 10)

  // Penalize/flag near-duplicates instead of dropping silently, per Basia's own process
  // (sometimes she deliberately reuses/refreshes a >30-day-old post).
  if (history.status === 'posted') score *= 0.05 // shown, but effectively pushed to the bottom
  if (history.status === 'recently_covered') score *= 0.15 // covered <30 days ago — mostly skip

  scored.push({ post, sources: [...sources], groupSize, history, score })
}

scored.sort((a, b) => b.score - a.score)

// Guarantee representation from every discovery lens instead of letting raw x-factor/likes crowd
// out image-groups and topic-clusters (Basia explicitly wants these as separate visible slices, not
// just a scoring tiebreak). Reserve slots, fill xfactor/likes-only items into what's left.
const MIN_PER_LENS = 3
function takeBySource(list, sourceName, n) {
  const taken = []
  for (const item of list) {
    if (taken.length >= n) break
    if (item.history.status === 'posted') continue // never force-include something already posted
    if (item.sources.includes(sourceName)) taken.push(item)
  }
  return taken
}

const reservedImage = takeBySource(scored, 'image_group', MIN_PER_LENS)
const reservedTopic = takeBySource(scored, 'topic_cluster', MIN_PER_LENS)
// A post can carry both image_group and topic_cluster tags and get picked into both reserved
// lists — dedupe by id while merging so it doesn't occupy two of the 20 slots with itself.
const reservedById = new Map()
for (const r of [...reservedImage, ...reservedTopic]) reservedById.set(r.post.id, r)
const reserved = [...reservedById.values()]
const reservedIds = new Set(reservedById.keys())
const remaining = scored.filter((r) => !reservedIds.has(r.post.id))
const top20 = [...reserved, ...remaining]
  .slice(0, RESULT_SIZE)
  .sort((a, b) => b.score - a.score)

// --- 6. output ----------------------------------------------------------------------------------

if (asJson) {
  console.log(
    JSON.stringify(
      top20.map((r) => ({
        id: r.post.id,
        author: r.post.author_name,
        content_preview: (r.post.content ?? '').slice(0, 200),
        likes: r.post.likes,
        comments: r.post.comments,
        x_factor: r.post.x_factor,
        sources: r.sources,
        cluster_size: r.groupSize,
        status: r.history.status,
        similarity_to_own_post: Number(r.history.similarity?.toFixed(3) ?? 0),
        matched_own_post: r.history.matchedPost
          ? { id: r.history.matchedPost.id, posted_at: r.history.matchedPost.posted_at, age_days: r.history.ageDays ?? null }
          : null,
        score: Number(r.score.toFixed(2)),
      })),
      null,
      2,
    ),
  )
} else {
  console.log(`\n=== Research Digest — last ${TIMEFRAME_DAYS} days — goal: ${GOAL} ===\n`)
  top20.forEach((r, i) => {
    const flag =
      r.history.status === 'posted'
        ? '  [ALREADY POSTED]'
        : r.history.status === 'recently_covered'
        ? '  [COVERED RECENTLY]'
        : r.history.status === 'refresh_candidate'
        ? `  [REFRESH CANDIDATE — your similar post was ${r.history.ageDays}d ago]`
        : ''
    console.log(
      `${i + 1}. [${r.sources.join('+')}${r.groupSize > 1 ? `, cluster of ${r.groupSize}` : ''}] ` +
        `${r.post.author_name} — ${r.post.likes}L/${r.post.comments}C, x=${r.post.x_factor ?? '-'}${flag}`,
    )
    console.log(`   "${(r.post.content ?? '').replace(/\n/g, ' ').slice(0, 140)}..."`)
    console.log(`   score=${r.score.toFixed(1)}  ${r.post.url ?? ''}\n`)
  })
}

db.close()
