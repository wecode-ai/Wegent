import { afterEach, expect, test, vi } from 'vitest'

import { verifyCollaborationScheduleViews } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  { today: [2026, 9, 12], target: '2026-10-26', advances: 0 },
  { today: [2026, 9, 26], target: '2026-11-09', advances: 1 },
  { today: [2026, 11, 28], target: '2027-01-11', advances: 1 },
])('reaches the calendar drag date $target without advancing twice', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(...fixture.today, 12))
  const grids =
    fixture.today[1] === 9
      ? [
          ['2026-09-28', '2026-11-08'],
          ['2026-10-26', '2026-12-06'],
          ['2026-11-30', '2027-01-10'],
        ]
      : [
          ['2026-11-30', '2027-01-10'],
          ['2026-12-28', '2027-02-07'],
          ['2027-02-01', '2027-03-14'],
        ]
  let month = 0
  const dates = {}
  const reachedDrag = new Error('Calendar drag reached')
  const isVisible = selector => {
    const date = selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)?.[1]
    return !date || (date >= grids[month][0] && date <= grids[month][1])
  }
  const command = vi.fn(async (action, selector, options) => {
    switch (action) {
      case 'click':
        if (/collaboration-schedule-next|下一个月/.test(selector)) month += 1
        return
      case 'fill':
        dates[selector.includes('-start-date') ? 'start' : 'end'] = options.value
        return
      case 'getElementCount':
        return Number(isVisible(selector))
      case 'getAttribute':
        return `Scheduled Issue · ${dates.start} → ${dates.end}`
      case 'waitFor':
        expect(isVisible(selector), `Date outside visible calendar: ${selector}`).toBe(true)
        return
      case 'drag':
        expect(options.target).toContain(`collaboration-calendar-day-${fixture.target}`)
        expect(isVisible(options.target)).toBe(true)
        throw reachedDrag
      case 'setMainWindowSize':
      case 'select':
      case 'clickWhenEnabled':
        return
      default:
        throw new Error(`Unexpected command before calendar drag: ${action}`)
    }
  })

  await expect(
    verifyCollaborationScheduleViews({
      capture: vi.fn(),
      control: { command },
      issueTitle: 'Scheduled Issue',
      scoped: selector => selector,
      timeoutMs: 100,
    })
  ).rejects.toBe(reachedDrag)
  expect(month).toBe(fixture.advances)
})
