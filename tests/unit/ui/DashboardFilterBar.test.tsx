// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DashboardFilterBar, type Filters } from '@/app/DashboardFilterBar'

const baseFilters = (over: Partial<Filters> = {}): Filters => ({
  platforms: [],
  keywords: [],
  authors: [],
  minLikes: 0,
  minShares: 0,
  minXFactor: 0,
  timeframe: 'week',
  sort: 'recent',
  groupByImage: false,
  discoverTrends: false,
  imageThreshold: 0.8,
  textThreshold: 0.65,
  ...over,
})

const authors = [{ author_id: 'jane', author_name: 'Jane', platform: 'linkedin' as const }]

describe('DashboardFilterBar', () => {
  it('toggles a platform into the platforms subset (§17.4)', async () => {
    const onChange = vi.fn()
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /substack/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ platforms: ['substack'] }))
  })

  it('removes a platform when its pill is toggled off', async () => {
    const onChange = vi.fn()
    render(
      <DashboardFilterBar filters={baseFilters({ platforms: ['linkedin', 'substack'] })} availableAuthors={authors} onChange={onChange} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /linkedin/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ platforms: ['substack'] }))
  })

  it('selects all of a person’s accounts at once via the persona group (§17.3)', async () => {
    const onChange = vi.fn()
    const crossPlatform = [
      { author_id: 'lara-li', author_name: 'Lara Acosta', platform: 'linkedin' as const, isCore: true, persona: 'lara acosta' },
      { author_id: 'laraacosta', author_name: 'Lara Acosta', platform: 'substack' as const, isCore: true, persona: 'lara acosta' },
    ]
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={crossPlatform} onChange={onChange} />)
    await userEvent.type(screen.getByPlaceholderText(/find a creator/i), 'lara')
    await userEvent.click(screen.getByRole('checkbox', { name: /select all 2 accounts for lara acosta/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ authors: ['lara-li', 'laraacosta'] }))
  })

  it('groups a person’s accounts across platforms even without an explicit persona (derived from name)', async () => {
    const onChange = vi.fn()
    const sameName = [
      { author_id: 'noah-li', author_name: 'Noah West', platform: 'linkedin' as const },
      { author_id: 'noahwest', author_name: 'Noah West', platform: 'substack' as const },
    ]
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={sameName} onChange={onChange} />)
    await userEvent.type(screen.getByPlaceholderText(/find a creator/i), 'noah')
    await userEvent.click(screen.getByRole('checkbox', { name: /select all 2 accounts for noah west/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ authors: ['noah-li', 'noahwest'] }))
  })

  it('is search-first: lists no creators until you type', async () => {
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={vi.fn()} />)
    expect(screen.queryByRole('checkbox', { name: /jane/i })).not.toBeInTheDocument()
    expect(screen.getByText(/type a name to find/i)).toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText(/find a creator/i), 'jane')
    expect(screen.getByRole('checkbox', { name: /jane/i })).toBeInTheDocument()
  })

  it('shows already-selected creators (with a platform badge) while the search box is empty', () => {
    render(<DashboardFilterBar filters={baseFilters({ authors: ['jane'] })} availableAuthors={authors} onChange={vi.fn()} />)
    const row = screen.getByRole('checkbox', { name: /jane/i })
    expect(row).toBeChecked()
    expect(screen.getByText(/^LinkedIn$/, { selector: '.filter-bar__creator-platform' })).toBeInTheDocument()
  })

  it('has no “Core creators” shortcut anymore', () => {
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /core creators/i })).not.toBeInTheDocument()
  })

  it('selects a creator via the dropdown checkbox after searching', async () => {
    const onChange = vi.fn()
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={onChange} />)
    await userEvent.type(screen.getByPlaceholderText(/find a creator/i), 'jane')
    await userEvent.click(screen.getByRole('checkbox', { name: /jane/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ authors: ['jane'] }))
  })

  it('closes the creators dropdown when you click outside it', async () => {
    render(
      <div>
        <DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={vi.fn()} />
        <button type="button">outside</button>
      </div>,
    )
    const details = screen.getByText(/^Creators/).closest('details') as HTMLDetailsElement
    await userEvent.click(screen.getByText(/^Creators/))
    expect(details.open).toBe(true)
    await userEvent.click(screen.getByText('outside'))
    expect(details.open).toBe(false)
  })

  it('clears the creator selection with Clear', async () => {
    const onChange = vi.fn()
    render(<DashboardFilterBar filters={baseFilters({ authors: ['jane'] })} availableAuthors={authors} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ authors: [] }))
  })

  it('fires onSearch when the Search button is clicked', async () => {
    const onSearch = vi.fn()
    render(
      <DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={vi.fn()} onSearch={onSearch} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /search/i }))
    expect(onSearch).toHaveBeenCalledOnce()
  })

  it('adds a keyword chip on Enter', async () => {
    const onChange = vi.fn()
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={onChange} />)
    await userEvent.type(screen.getByLabelText(/add keyword/i), 'ai agents{Enter}')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keywords: ['ai agents'] }))
  })

  it('reveals the custom date range only when timeframe is custom', () => {
    const { rerender } = render(
      <DashboardFilterBar filters={baseFilters({ timeframe: 'week' })} availableAuthors={authors} onChange={vi.fn()} />,
    )
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
    rerender(
      <DashboardFilterBar filters={baseFilters({ timeframe: 'custom' })} availableAuthors={authors} onChange={vi.fn()} />,
    )
    expect(screen.getByLabelText('From')).toBeInTheDocument()
    expect(screen.getByLabelText('To')).toBeInTheDocument()
  })
})
