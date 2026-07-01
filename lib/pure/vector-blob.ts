// Layer 0 — Float32 vector <-> BLOB serialization (PRD §7.5). Zero I/O. 100% coverage required.

/** Serialize a numeric vector to a little-endian Float32 Buffer (4 bytes per element). */
export function vectorToBlob(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4)
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!
    if (!Number.isFinite(v)) {
      throw new Error(`vectorToBlob: non-finite value at index ${i}`)
    }
    buf.writeFloatLE(v, i * 4)
  }
  return buf
}

/** Inverse of vectorToBlob; null-safe. Throws if the buffer is not a whole number of Float32s. */
export function blobToVector(buf: Buffer | null): number[] | null {
  if (buf === null) return null
  if (buf.length % 4 !== 0) {
    throw new Error(`blobToVector: buffer length ${buf.length} is not a multiple of 4`)
  }
  const out: number[] = new Array(buf.length / 4)
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readFloatLE(i * 4)
  }
  return out
}
