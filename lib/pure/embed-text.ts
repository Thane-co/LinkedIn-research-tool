// Layer 0 — build the string embedded into a post's text vector (PRD §7.2). Zero I/O.
// Combine post text with the image description (if present) so the visual topic signal lands in
// the text embedding used for content clustering.

export function buildEmbeddingText(
  content: string | null | undefined,
  imageDescription?: string | null,
): string {
  const base = (content ?? '').trim()
  if (imageDescription) return `${base}\n\n[Image content: ${imageDescription}]`
  return base
}
