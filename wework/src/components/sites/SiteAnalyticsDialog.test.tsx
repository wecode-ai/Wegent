import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ApiError } from '@/api/http'
import {
  createUnavailableSitesApi,
  type Site,
  type SiteAnalytics,
  type SiteAnalyticsRange,
} from '@/api/sites'
import { SiteAnalyticsDialog } from './SiteAnalyticsDialog'
import { recentAnalyticsRange } from './siteAnalyticsDates'

const site = { siteid: 'prj-site', name: '测试站点' } as Site
function result(range: SiteAnalyticsRange): SiteAnalytics {
  return {
    ...range,
    project_id: site.siteid,
    timezone: 'Asia/Shanghai',
    totals: { pv: 5, uv: 2 },
    daily: [
      { date: range.start_date, pv: 2, uv: 2 },
      { date: range.end_date, pv: 3, uv: 2 },
    ],
    queried_at: '2026-10-01T08:00:00Z',
  }
}
function setup(get = vi.fn().mockImplementation((_id, range) => Promise.resolve(result(range)))) {
  const onClose = vi.fn()
  const api = { ...createUnavailableSitesApi(), getSiteAnalytics: get }
  const view = render(<SiteAnalyticsDialog api={api} site={site} onClose={onClose} />)
  return { get, onClose, ...view }
}

describe('site analytics dialog', () => {
  test('loads seven days and displays independent total UV, detail and trend', async () => {
    const { get } = setup()
    expect(get).toHaveBeenCalledWith(site.siteid, recentAnalyticsRange(7))
    const totals = await screen.findByTestId('site-analytics-totals')
    expect(totals).toHaveTextContent('5')
    expect(totals).toHaveTextContent('2')
    expect(totals).not.toHaveTextContent('4')
    expect(screen.getByTestId('site-analytics-trend')).toBeInTheDocument()
    expect(within(screen.getByTestId('site-analytics-daily')).getAllByRole('row')).toHaveLength(3)
    expect(screen.getByTestId('site-analytics-result-range')).toHaveTextContent(
      recentAnalyticsRange(7).start_date
    )
  })
  test('blocks 32 days and reversed dates; allows 31 and same-day queries', async () => {
    const { get } = setup()
    await screen.findByTestId('site-analytics-totals')
    const start = screen.getByTestId('site-analytics-start_date')
    const end = screen.getByTestId('site-analytics-end_date')
    const query = screen.getByTestId('site-analytics-query')
    fireEvent.change(start, { target: { value: '2026-08-01' } })
    fireEvent.change(end, { target: { value: '2026-09-01' } })
    expect(query).toBeDisabled()
    expect(get).toHaveBeenCalledTimes(1)
    fireEvent.change(end, { target: { value: '2026-08-31' } })
    await userEvent.click(query)
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(site.siteid, {
        start_date: '2026-08-01',
        end_date: '2026-08-31',
      })
    )
    fireEvent.change(start, { target: { value: '2026-09-01' } })
    expect(query).toBeDisabled()
    fireEvent.change(start, { target: { value: '2026-08-31' } })
    await userEvent.click(query)
    expect(get).toHaveBeenLastCalledWith(site.siteid, {
      start_date: '2026-08-31',
      end_date: '2026-08-31',
    })
  })
  test('shows query errors and retries without presenting zero visits', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError('not configured', 503, 'ANALYTICS_NOT_CONFIGURED', {
          code: 'ANALYTICS_NOT_CONFIGURED',
        })
      )
      .mockImplementation((_id, range) =>
        Promise.resolve({ ...result(range), totals: { pv: 0, uv: 0 }, daily: [] })
      )
    setup(get)
    expect(await screen.findByRole('alert')).toHaveTextContent('配置')
    expect(screen.queryByTestId('site-analytics-totals')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('site-analytics-retry'))
    expect(await screen.findByTestId('site-analytics-totals')).toHaveTextContent('0')
    expect(screen.getByRole('status')).toHaveTextContent('暂无访问记录')
    expect(get).toHaveBeenCalledTimes(2)
  })
  test('ignores an old response after switching the range and closes with Escape', async () => {
    let resolveOld!: (value: SiteAnalytics) => void
    const old = new Promise<SiteAnalytics>(resolve => {
      resolveOld = resolve
    })
    const get = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockImplementation((_id, range) => Promise.resolve(result(range)))
    const { onClose } = setup(get)
    expect(screen.getByRole('status')).toHaveTextContent('查询')
    await userEvent.click(screen.getByTestId('site-analytics-recent-31'))
    expect(await screen.findByTestId('site-analytics-result-range')).toHaveTextContent(
      recentAnalyticsRange(31).start_date
    )
    resolveOld(result(recentAnalyticsRange(7)))
    await waitFor(() =>
      expect(screen.getByTestId('site-analytics-result-range')).toHaveTextContent(
        recentAnalyticsRange(31).start_date
      )
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  test('traps keyboard focus and restores the connected trigger on unmount', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = setup()
    await screen.findByTestId('site-analytics-totals')
    const last = screen.getByTestId('site-analytics-recent-31')
    last.focus()
    await userEvent.tab()
    expect(screen.getByTestId('site-analytics-close')).toHaveFocus()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
