// @vitest-environment jsdom
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsPanel, type SettingsView } from '@/app/SettingsPanel'
import { server } from '@/tests/msw/server'

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  settings: {
    apify_api_token: 'unset',
    voyage_api_key: 'unset',
    anthropic_api_key: 'unset',
    apify_keyword_actor_id: 'harvestapi/linkedin-post-search',
    ...over.settings,
  },
  ready: { apify: false, voyage: false, anthropic: false, ...over.ready },
})

afterEach(() => server.resetHandlers())

describe('SettingsPanel', () => {
  it('shows an onboarding gate while Apify or Voyage is not ready', () => {
    render(<SettingsPanel view={view()} />)
    expect(screen.getByTestId('settings-gate')).toBeInTheDocument()
  })

  it('surfaces a save failure instead of silently reporting success', async () => {
    server.use(http.put('*/api/settings', () => new HttpResponse(null, { status: 500 })))
    render(<SettingsPanel view={view()} />)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByTestId('settings-error')).toHaveTextContent(/failed|error|couldn/i)
  })

  it('hides the gate once both required providers are ready', () => {
    render(<SettingsPanel view={view({ ready: { apify: true, voyage: true, anthropic: false } })} />)
    expect(screen.queryByTestId('settings-gate')).not.toBeInTheDocument()
  })

  it('saves only the edited keys via PUT and reports the refreshed view', async () => {
    let putBody: Record<string, string> | null = null
    server.use(
      http.put('*/api/settings', async ({ request }) => {
        putBody = (await request.json()) as Record<string, string>
        return HttpResponse.json({
          settings: { ...view().settings, apify_api_token: 'set' },
          ready: { apify: true, voyage: false, anthropic: false },
        })
      }),
    )
    const saved: SettingsView[] = []
    render(<SettingsPanel view={view()} onSaved={(v) => saved.push(v)} />)

    await userEvent.type(screen.getByLabelText(/apify api token/i), 'tok-123')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(putBody).toEqual({ apify_api_token: 'tok-123' }) // untouched keys not sent
    expect(saved.at(-1)?.ready.apify).toBe(true)
  })

  it('runs the per-provider connection test and shows the results', async () => {
    server.use(
      http.post('*/api/settings/test', () =>
        HttpResponse.json({
          apify: { ok: true },
          voyage: { ok: false, error: 'HTTP 401' },
          anthropic: { ok: false, error: 'API key not set' },
        }),
      ),
    )
    render(<SettingsPanel view={view()} />)
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }))

    expect(await screen.findByTestId('test-apify')).toHaveAttribute('data-ok', 'true')
    expect(screen.getByTestId('test-voyage')).toHaveAttribute('data-ok', 'false')
  })
})
