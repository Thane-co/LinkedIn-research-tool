// Layer 3 — enrichPosts (PRD §7.3, §12 step 20). Non-fatal: logs errors, never aborts a scrape.
// TDD: mocks repo + voyage; never re-embeds unless reEmbed; remaining count correct.

import { countUnembedded, getUnembedded, setEmbedding } from '@/lib/db/posts.repo'
import { resetVectorIndex } from '@/lib/db/vector-index'
import { buildEmbeddingText } from '@/lib/pure/embed-text'
import { vectorToBlob } from '@/lib/pure/vector-blob'
import { embedImage, embedTexts } from '@/lib/voyage'
import { describeImage } from '@/lib/anthropic'

/**
 * Load unembedded posts, build embedding text (+optional image description), batch-embed via
 * Voyage, write BLOBs. Never re-embeds a post that already has an embedding unless reEmbed.
 * Per-image failures (embed/describe) are logged and swallowed so one bad image can't stall the
 * batch; a total text-embed failure throws so the caller can log it non-fatally.
 */
export async function enrichPosts(
  limit: number,
  opts?: { reEmbed?: boolean },
): Promise<{ embedded: number; remaining: number }> {
  const reEmbed = opts?.reEmbed ?? false
  const posts = getUnembedded(limit, { reEmbed })
  if (posts.length === 0) {
    return { embedded: 0, remaining: countUnembedded() }
  }

  // Only call Voyage for posts actually missing a text embedding (honor "never re-embed" unless
  // reEmbed). Posts selected only to backfill a missing image embedding reuse their stored text
  // vector, so we never re-embed text just to fill in a poster thumbnail.
  const needText = posts.filter((p) => reEmbed || p.embedding === null)
  const vectors = needText.length > 0 ? await embedTexts(needText.map((p) => buildEmbeddingText(p.content, p.image_description))) : []
  const textBlobById = new Map<string, Buffer>()
  needText.forEach((p, i) => textBlobById.set(p.id, vectorToBlob(vectors[i]!)))
  const now = new Date().toISOString()

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!
    const textBlob = textBlobById.get(post.id) ?? post.embedding!

    // Text-only posts: write just the text vector (leave image columns untouched).
    if (!post.image_url) {
      setEmbedding(post.id, textBlob, now)
      continue
    }

    // Image posts (v1: image embeddings ON, Claude descriptions OFF). Each side is non-fatal and
    // an existing description is preserved when Claude is disabled (describeImage → null).
    let imageBlob: Buffer | null = null
    try {
      imageBlob = vectorToBlob(await embedImage(post.image_url))
    } catch (err) {
      console.error(`enrich: image embedding failed for ${post.id}:`, (err as Error).message)
    }

    let description: string | null = post.image_description
    try {
      description = (await describeImage(post.image_url)) ?? post.image_description
    } catch (err) {
      console.error(`enrich: image description failed for ${post.id}:`, (err as Error).message)
    }

    setEmbedding(post.id, textBlob, now, imageBlob, description)
  }

  // The vector index is an in-process cache of these very rows (§9.5). Without this, posts embedded
  // during this run stay invisible to semantic search until the server restarts.
  resetVectorIndex()

  return { embedded: posts.length, remaining: countUnembedded() }
}
