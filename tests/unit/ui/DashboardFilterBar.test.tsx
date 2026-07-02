// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DashboardFilterBar, type Filters } from '@/app/DashboardFilterBar'

const baseFilters = (over: Partial<Filters> = {}): Filters => ({
  platform: 'all',
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

const authors = [{ author_id: 'jane', author_name: 'Jane' }]

describe('DashboardFilterBar', () => {
  it('emits the updated filter when the platform changes', async () => {
    const onChange = vi.fn()
    render(<DashboardFilterBar filters={baseFilters()} availableAuthors={authors} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText(/platform/i), 'twitter')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ platform: 'twitter' }))
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
