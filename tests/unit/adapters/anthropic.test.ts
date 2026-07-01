import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDb } from '@/lib/db/db'
import { setSettings } from '@/lib/settings'
import { describeImage } from '@/lib/anthropic'
import { server } from '@/tests/msw/server'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

beforeEach(() => getDb(':memory:'))
afterEach(() => resetDb())

describe('describeImage', () => {
  it('returns the description text on success', async () => {
    setSettings({ anthropic_api_key: 'ak' })
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json({ content: [{ type: 'text', text: 'A bar chart of revenue.' }] }),
      ),
    )
    expect(await describeImage('https://img/1.png')).toBe('A bar chart of revenue.')
  })

  it('sends the required headers and an image-by-url content block', async () => {
    setSettings({ anthropic_api_key: 'ak' })
    let captured: { headers: Headers; body: any } | null = null
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        captured = { headers: request.headers, body: await request.json() }
        return HttpResponse.json({ content: [{ type: 'text', text: 'ok' }] })
      }),
    )
    await describeImage('https://img/1.png')
    expect(captured!.headers.get('x-api-key')).toBe('ak')
    expect(captured!.headers.get('anthropic-version')).toBe('2023-06-01')
    const image = captured!.body.messages[0].content.find((b: any) => b.type === 'image')
    expect(image.source).toEqual({ type: 'url', url: 'https://img/1.png' })
  })

  it('returns null (feature disabled) when the Anthropic key is unset — no throw', async () => {
    expect(await describeImage('https://img/1.png')).toBeNull()
  })

  it('throws on an HTTP error so the enrich job can log it (non-fatal upstream)', async () => {
    setSettings({ anthropic_api_key: 'ak' })
    server.use(http.post(MESSAGES_URL, () => new HttpResponse(null, { status: 500 })))
    await expect(describeImage('https://img/1.png')).rejects.toThrow(/anthropic/i)
  })
})
