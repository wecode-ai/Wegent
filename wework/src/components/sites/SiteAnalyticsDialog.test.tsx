import { ApiError } from '@/api/http'
import {
  createUnavailableSitesApi,
  type Site,
  type SiteAnalytics,
  type SiteAnalyticsRange,
} from '@/api/sites'
import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { SiteAnalyticsDialog } from './SiteAnalyticsDialog'

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
