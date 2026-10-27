import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'
import { verifyCollaborationScheduleViews } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  {
    today: '2026-10-19T12:00:00',
    target: '2026-10-26',
    navigationCount: 0,
    ranges: [
      '2026-10-19 → 2026-10-21',
      '2026-10-26 → 2026-10-28',
      '2026-10-26 → 2026-10-29',
      '2026-10-28 → 2026-10-31',
    ],
  },
  {
    today: '2026-10-26T12:00:00',
    target: '2026-11-02',
    navigationCount: 0,
    ranges: [
      '2026-10-26 → 2026-10-28',
      '2026-11-02 → 2026-11-04',
      '2026-11-02 → 2026-11-05',
      '2026-11-04 → 2026-11-07',
    ],
  },
  {
    today: '2026-10-05T12:00:00',
    target: '2026-10-12',
    navigationCount: 0,
    ranges: [
      '2026-10-05 → 2026-10-07',
      '2026-10-12 → 2026-10-14',
      '2026-10-12 → 2026-10-15',
      '2026-10-14 → 2026-10-17',
    ],
  },
  {
    today: '2026-12-28T12:00:00',
    target: '2027-01-04',
    navigationCount: 0,
    ranges: [
      '2026-12-28 → 2026-12-30',
      '2027-01-04 → 2027-01-06',
      '2027-01-04 → 2027-01-07',
      '2027-01-06 → 2027-01-09',
    ],
  },
])('keeps the target date visible when scheduling from $today', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(fixture.today))
  let navigations = 0
  let rangeIndex = 0
  const calendarDays = []
  const control = {
    async command(action, selector, options) {
      if (action === 'click' && /collaboration-schedule-next|下一个月/.test(selector)) navigations++
      if (action === 'waitFor' && selector.includes('collaboration-calendar-day-')) {
        calendarDays.push(selector)
        assert.equal(navigations, fixture.navigationCount, 'The target month was overshot')
        assert.equal(options.visible, true)
      }
      if (action === 'getAttribute')
        return options.value === 'aria-sort' ? 'ascending' : fixture.ranges[rangeIndex]
      if (action === 'drag' || action === 'dragBy') rangeIndex++
      if (action === 'getValue') return 'status'
      if (action === 'getComputedStyleValue') return 'ew-resize'
      if (action === 'getText') return '开始时间 结束时间'
      return ''
    },
  }

  await verifyCollaborationScheduleViews({
    capture: async () => {},
    control,
    issueTitle: 'Calendar navigation regression',
    scoped: selector => selector,
    timeoutMs: 100,
  })

  expect(navigations).toBe(fixture.navigationCount)
  expect(calendarDays).toEqual([
    `[data-testid="collaboration-calendar-day-${fixture.ranges[0].split(' → ')[0]}"]`,
    `[data-testid="collaboration-calendar-day-${fixture.target}"]`,
  ])
  expect(rangeIndex).toBe(3)
})
