// Layer 2 — OPTIONAL Claude-vision image description (PRD §7.4, §12 step 19).
// Reads anthropic_api_key from settings (BYO). Optional feature: returns null when the key is unset
// (feature disabled), throws on a real HTTP error so the enrich job can log it non-fatally.
// API shape verified against the claude-api reference: POST /v1/messages, anthropic-version header,
// image-by-url source block. Model is IMAGE_DESCRIPTION_MODEL (PRD pins claude-sonnet-4-6).

import { IMAGE_DESCRIPTION_MODEL } from '@/lib/config'
import { getKey } from '@/lib/settings'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DESCRIBE_PROMPT =
  'Describe this image in 1-2 factual sentences. Focus on the visible content (charts, text, subjects); do not speculate.'

/** 1-2 sentence factual description of the image at url, or null when the feature is disabled. */
export async function describeImage(url: string): Promise<string | null> {
  const key = getKey('anthropic_api_key')
  if (!key) return null // optional feature — degrade gracefully

  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_DESCRIPTION_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url } },
            { type: 'text', text: DESCRIBE_PROMPT },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`Anthropic: image description failed (${res.status})`)
  }
  const json = (await res.json()) as { content: { type: string; text?: string }[] }
  const text = json.content.find((b) => b.type === 'text')?.text
  return text ?? null
}
