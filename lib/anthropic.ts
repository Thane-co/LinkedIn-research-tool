// Layer 2 — OPTIONAL Claude-vision image description (PRD §7.4, §12 step 19).
// Reads anthropic_api_key from settings (BYO). Optional feature: returns null when the key is unset
// (feature disabled), throws on a real HTTP error so the enrich job can log it non-fatally.
// API shape verified against the claude-api reference: POST /v1/messages, anthropic-version header,
// image-by-url source block. Model is IMAGE_DESCRIPTION_MODEL (PRD pins claude-sonnet-4-6).

import { execFile } from 'node:child_process'
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

// A hung CLI call must never wedge the daily post-loop — kill it after this long and return null.
const CLI_TIMEOUT_MS = 120_000
// The claude CLI streams the whole conversation into one JSON blob; give it generous headroom.
const CLI_MAX_BUFFER = 10 * 1024 * 1024

/** The `--output-format json` result envelope the claude CLI prints on stdout (fields we read). */
interface CliResult {
  type?: string
  subtype?: string
  result?: string
}

/**
 * Single-shot text completion via the local `claude` CLI in print mode (`-p ... --output-format json
 * --max-turns 1`), so it rides Basia's existing Claude subscription (the CLI's own OAuth session) and
 * needs NO `anthropic_api_key` — unlike `describeImage`, which keeps the BYO API-key path. Used by the
 * daily post-loop to rewrite the audience-fit profile doc.
 *
 * Degrades gracefully: a missing binary, a non-zero exit, a timeout, a non-`success` subtype, or
 * unparseable output all log a clear stderr line and return `null` — this function never throws.
 * The prompt (and system text) are passed as direct argv args, never through a shell, so quotes and
 * newlines in profile/post text are safe.
 */
export async function completeText(params: { prompt: string; system?: string; maxTokens?: number }): Promise<string | null> {
  const args = ['-p', params.prompt, '--output-format', 'json', '--max-turns', '1']
  if (params.system) args.push('--append-system-prompt', params.system)

  let stdout: string
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile('claude', args, { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER }, (err, out) => {
        if (err) reject(err)
        else resolve(out)
      })
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
    if (e.code === 'ENOENT') {
      console.error('completeText: claude CLI not found — is it installed and on PATH?')
    } else if (e.killed || e.signal === 'SIGTERM') {
      console.error(`completeText: claude CLI timed out after ${CLI_TIMEOUT_MS}ms — killed`)
    } else {
      console.error(`completeText: claude CLI exited with an error — ${e instanceof Error ? e.message : e}`)
    }
    return null
  }

  let parsed: CliResult
  try {
    parsed = JSON.parse(stdout) as CliResult
  } catch (err) {
    console.error(`completeText: could not parse claude CLI JSON output — ${err instanceof Error ? err.message : err}`)
    return null
  }
  if (parsed.subtype !== 'success') {
    console.error(`completeText: claude CLI returned subtype "${parsed.subtype}" — expected "success"`)
    return null
  }
  return parsed.result ?? null
}
