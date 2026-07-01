// Layer 3 — enrichPosts (PRD §7.3, §12 step 20). Non-fatal: logs errors, never aborts a scrape.
// TDD: mocks repo + voyage; never re-embeds unless reEmbed; remaining count correct.

/**
 * Load unembedded posts, build embedding text (+optional image description), batch-embed via
 * Voyage, write BLOBs. Never re-embeds a post that already has an embedding unless reEmbed.
 */
export function enrichPosts(_limit: number, _opts?: { reEmbed?: boolean }): Promise<{
  embedded: number
  remaining: number
}> {
  throw new Error('Not implemented — see PRD §7.3')
}
