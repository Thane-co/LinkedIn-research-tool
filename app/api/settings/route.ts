// Layer 4 — GET/PUT /api/settings (PRD §11.4, §12 step 22). Thin.
// GET masks secret values (returns 'set'/'unset', never raw) + a `ready` summary.
// PUT upserts only the keys present (partial); trims; empty string clears.

import { NextResponse } from 'next/server'
import { SECRET_SETTING_KEYS } from '@/lib/config'
import { getKey, getSettings, readiness, setSettings } from '@/lib/settings'

/** Merged settings with every secret key masked to 'set'/'unset' (never the raw value). */
function maskedView(): { settings: Record<string, string>; ready: ReturnType<typeof readiness> } {
  const settings: Record<string, string> = { ...getSettings() }
  for (const key of SECRET_SETTING_KEYS) settings[key] = getKey(key) ? 'set' : 'unset'
  return { settings, ready: readiness() }
}

export async function GET(_req: Request): Promise<NextResponse> {
  return NextResponse.json(maskedView())
}

export async function PUT(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as Record<string, unknown>
  const partial: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') partial[key] = value.trim() // empty string = explicit clear
  }
  setSettings(partial)
  return NextResponse.json(maskedView())
}
