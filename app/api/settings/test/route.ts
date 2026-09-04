// Layer 4 — POST /api/settings/test (PRD §11.4, optional). Cheap live per-provider check
// (Apify GET /v2/users/me; Voyage 1-token embed; Anthropic 1-token message) -> { ok, error? }.
// Reads BYO keys from settings; a provider with no key is reported not-ok (never probed).

import { NextResponse } from 'next/server'
import { IMAGE_DESCRIPTION_MODEL, TEXT_EMBEDDING_MODEL, VOYAGE_TEXT_URL } from '@/lib/config'
import { rejectCrossOrigin } from '@/lib/api-guard'
import { getKey } from '@/lib/settings'

type ProbeResult = { ok: boolean; error?: string }

const okOr = (res: Response): ProbeResult => (res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` })

async function probe(run: () => Promise<ProbeResult>): Promise<ProbeResult> {
  try {
    return await run()
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function testApify(): Promise<ProbeResult> {
  const token = getKey('apify_api_token')
  if (!token) return { ok: false, error: 'API token not set' }
  return probe(async () => okOr(await fetch(`https://api.apify.com/v2/users/me?token=${token}`)))
}

async function testVoyage(): Promise<ProbeResult> {
  const key = getKey('voyage_api_key')
  if (!key) return { ok: false, error: 'API key not set' }
  return probe(async () =>
    okOr(
      await fetch(VOYAGE_TEXT_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: ['ping'], model: TEXT_EMBEDDING_MODEL }),
      }),
    ),
  )
}

async function testAnthropic(): Promise<ProbeResult> {
  const key = getKey('anthropic_api_key')
  if (!key) return { ok: false, error: 'API key not set' }
  return probe(async () =>
    okOr(
      await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: IMAGE_DESCRIPTION_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      }),
    ),
  )
}

// Gates only the temporary ig-compare tab, not core Search.
async function testAssemblyai(): Promise<ProbeResult> {
  const key = getKey('assemblyai_api_key')
  if (!key) return { ok: false, error: 'API key not set' }
  return probe(async () => okOr(await fetch('https://api.assemblyai.com/v2/transcript?limit=1', { headers: { authorization: key } })))
}

export async function POST(req: Request): Promise<NextResponse> {
  const blocked = rejectCrossOrigin(req)
  if (blocked) return blocked
  const [apify, voyage, anthropic, assemblyai] = await Promise.all([testApify(), testVoyage(), testAnthropic(), testAssemblyai()])
  return NextResponse.json({ apify, voyage, anthropic, assemblyai })
}
