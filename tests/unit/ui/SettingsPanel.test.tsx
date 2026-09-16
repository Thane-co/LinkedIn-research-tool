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
    apify_substack_actor_id: 'brilliant_gum/substack-insights-scraper',
    apify_instagram_actor_id: 'apify/instagram-post-scraper',
    ...over.settings,
  },
  ready: { apify: false, voyage: false, anthropic: false, assemblyai: false, ...over.ready },
})

afterEach(() => server.resetHandlers())

describe('SettingsPanel', () => {
  it('shows an onboarding gate while Apify or Voyage is not ready', () => {
    render(<SettingsPanel view={view()} />)
    expect(screen.getByTestId('settings-gate')).toBeInTheDocument()
  })

  it('shows the editable Substack actor field with its current value (§17.1)', () => {
    render(<SettingsPanel view={view()} />)
    const field = screen.getByLabelText(/substack actor/i)
    expect(field).toHaveValue('brilliant_gum/substack-insights-scraper')
  })

  it('shows the editable Instagram actor field with its current value + a link to the actor (§18)', () => {
    render(<SettingsPanel view={view()} />)
    expect(screen.getByLabelText(/instagram actor/i)).toHaveValue('apify/instagram-post-scraper')
    const link = screen.getAllByRole('link', { name: /view actor/i })
    expect(link.some((a) => a.getAttribute('href') === 'https://apify.com/apify/instagram-post-scraper')).toBe(true)
  })

  it('shows the comments actor and her own author id, which scopes comment scraping (§23)', () => {
    render(
      <SettingsPanel
        view={view({
          settings: { apify_comments_actor_id: 'harvestapi/linkedin-post-comments', own_linkedin_author_id: 'basiakubicka' },
        })}
      />,
    )
    expect(screen.getByLabelText(/comments actor/i)).toHaveValue('harvestapi/linkedin-post-comments')
    expect(screen.getByLabelText(/your linkedin author id/i)).toHaveValue('basiakubicka')
  })

  it('surfaces a save failure instead of silently reporting success', async () => {
    server.use(http.put('*/api/settings', () => new HttpResponse(null, { status: 500 })))
    render(<SettingsPanel view={view()} />)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByTestId('settings-error')).toHaveTextContent(/failed|error|couldn/i)
  })

  it('hides the gate once both required providers are ready', () => {
    render(<SettingsPanel view={view({ ready: { apify: true, voyage: true, anthropic: false, assemblyai: false } })} />)
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
          assemblyai: { ok: false, error: 'API key not set' },
        }),
      ),
    )
    render(<SettingsPanel view={view()} />)
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }))

    expect(await screen.findByTestId('test-apify')).toHaveAttribute('data-ok', 'true')
    expect(screen.getByTestId('test-voyage')).toHaveAttribute('data-ok', 'false')
  })
})
