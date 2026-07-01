// Fixtures for Voyage responses + tiny hand-built vectors (PRD §13).
// Tip: keep similarity/clustering dimension-agnostic so tests can use 4-dim vectors.

/** Shape of a Voyage /v1/embeddings success response (fill in when writing voyage.ts tests). */
export const voyageEmbeddingResponse = {
  data: [] as { embedding: number[]; index: number }[],
  model: 'voyage-3',
  usage: { total_tokens: 0 },
}

// Small orthogonal / parallel vectors for similarity + clustering unit tests (steps 3-5).
export const vecA = [1, 0, 0, 0]
export const vecAlike = [0.99, 0.01, 0, 0]
export const vecB = [0, 1, 0, 0]
