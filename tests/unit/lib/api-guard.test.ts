import { describe, expect, it } from 'vitest'
import { rejectCrossOrigin } from '@/lib/api-guard'

const post = (origin?: string): Request =>
  new Request('http://localhost:3000/api/scrape', {
    method: 'POST',
    headers: origin ? { origin } : {},
  })

describe('rejectCrossOrigin', () => {
  it('allows a request with no Origin header (same-origin nav / server-to-server / tests)', () => {
    expect(rejectCrossOrigin(post())).toBeNull()
  })

  it('allows the local app as origin, on any port and over http/https', () => {
    expect(rejectCrossOrigin(post('http://localhost:3000'))).toBeNull()
    expect(rejectCrossOrigin(post('http://127.0.0.1:3000'))).toBeNull()
    expect(rejectCrossOrigin(post('https://localhost'))).toBeNull()
  })

  it('refuses a cross-origin request with 403', () => {
    expect(rejectCrossOrigin(post('https://evil.example.com'))?.status).toBe(403)
  })

  it('refuses a malformed Origin with 403', () => {
    expect(rejectCrossOrigin(post('not a url'))?.status).toBe(403)
  })
})
