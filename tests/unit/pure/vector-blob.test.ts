import { describe, expect, it } from 'vitest'
import { blobToVector, vectorToBlob } from '@/lib/pure/vector-blob'
import { EMBEDDING_DIM } from '@/lib/config'

describe('vectorToBlob / blobToVector', () => {
  it('round-trips a 1024-dim vector within Float32 epsilon', () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i) * 0.5)
    const blob = vectorToBlob(vec)
    const back = blobToVector(blob)
    expect(back).not.toBeNull()
    expect(back!).toHaveLength(EMBEDDING_DIM)
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(back![i]).toBeCloseTo(vec[i]!, 5)
    }
  })

  it('serializes to exactly 4 bytes per element (Float32)', () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, () => 0)
    const blob = vectorToBlob(vec)
    expect(blob).toBeInstanceOf(Buffer)
    expect(blob.length).toBe(EMBEDDING_DIM * 4)
  })

  it('is dimension-agnostic (works for tiny vectors)', () => {
    const back = blobToVector(vectorToBlob([1, 0, -1, 0.25]))
    expect(back).toEqual([1, 0, -1, 0.25])
  })

  it('preserves little-endian byte order', () => {
    // 1.0 as Float32 LE = 00 00 80 3F
    const blob = vectorToBlob([1])
    expect([...blob]).toEqual([0x00, 0x00, 0x80, 0x3f])
  })

  it('throws on a wrong-length (non-multiple-of-4) buffer', () => {
    expect(() => blobToVector(Buffer.from([1, 2, 3]))).toThrow()
  })

  it('returns null for a null buffer', () => {
    expect(blobToVector(null)).toBeNull()
  })

  it('rejects non-finite values rather than silently corrupting data', () => {
    expect(() => vectorToBlob([Number.NaN])).toThrow()
  })
})
