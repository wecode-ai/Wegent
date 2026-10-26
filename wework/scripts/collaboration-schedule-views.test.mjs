import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'

import {
  calendarDays,
  localDateKey,
  startOfScheduleWeek,
} from '../../packages/collaboration/src/project-schedule/model'
import {
  scheduleStartDate,
  verifyCollaborationScheduleViews,
} from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

function key(date) {
  return [date.getFullYear(), date.getMonth(), date.getDate()].join('-')
}

function addDays(date, count) {
  const result = new Date(date)
  result.setDate(result.getDate() + count)
  return result
}

test('October 26 schedules its complete calendar drag inside the displayed month', () => {
  const today = new Date(2026, 9, 26, 12)
  const start = scheduleStartDate(today)
  const days = new Set(calendarDays(today, true).map(key))

  assert.equal(key(start), '2026-9-26')
  assert.ok(days.has(key(addDays(start, 7))), 'The calendar drag target must exist')
  assert.ok(days.has(key(addDays(start, 9))), 'The moved range must remain visible')
})

test('calendar fixtures fit real calendar and Gantt windows across month and leap-year boundaries', () => {
  for (const year of [2024, 2025, 2026, 2027]) {
    for (
      let today = new Date(year, 0, 1, 12);
      today.getFullYear() === year;
      today = addDays(today, 1)
    ) {
      const start = scheduleStartDate(today)
      const days = new Set(calendarDays(today, true).map(key))
      const label = today.toDateString()
      assert.ok(days.has(key(start)), `Initial range starts outside the calendar: ${label}`)
      assert.ok(
        days.has(key(addDays(start, 2))),
        `Initial range ends outside the calendar: ${label}`
      )
      assert.ok(days.has(key(addDays(start, 7))), `Drag target is outside the calendar: ${label}`)
      assert.ok(days.has(key(addDays(start, 9))), `Moved range is outside the calendar: ${label}`)
      assert.ok(
        addDays(start, 7) >= startOfScheduleWeek(today, true),
        `Moved range precedes the Gantt window: ${label}`
      )
    }
  }
})

const monthEndSchedule = {
  today: '2026-10-26T12:00:00',
  target: '2026-11-02',
  navigationCount: 0,
  ranges: [
    '2026-10-26 → 2026-10-28',
    '2026-11-02 → 2026-11-04',
    '2026-11-02 → 2026-11-05',
    '2026-11-04 → 2026-11-07',
  ],
}

const yearEndSchedule = {
  today: '2026-12-28T12:00:00',
  target: '2027-01-04',
  navigationCount: 0,
  ranges: [
    '2026-12-28 → 2026-12-30',
    '2027-01-04 → 2027-01-06',
    '2027-01-04 → 2027-01-07',
    '2027-01-06 → 2027-01-09',
  ],
}

test.each([
  { ...monthEndSchedule, today: '2026-10-19T12:00:00' },
  monthEndSchedule,
  // A restored calendar can start one month behind the task date.
  { ...monthEndSchedule, navigationCount: 1, displayedMonthOffset: -1 },
  {
    today: '2026-10-05T12:00:00',
    target: '2026-10-19',
    navigationCount: 0,
    ranges: [
      '2026-10-12 → 2026-10-14',
      '2026-10-19 → 2026-10-21',
      '2026-10-19 → 2026-10-22',
      '2026-10-21 → 2026-10-24',
    ],
  },
  yearEndSchedule,
  { ...yearEndSchedule, navigationCount: 1, displayedMonthOffset: -1 },
])(
  'keeps the target date visible from $today after $navigationCount month advances',
  async fixture => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const today = new Date(fixture.today)
    vi.setSystemTime(today)
    let navigations = 0
    let rangeIndex = 0
    const dayVisible = date => {
      const displayedMonth = new Date(today.getFullYear(), today.getMonth(), 1, 12)
      displayedMonth.setMonth(
        displayedMonth.getMonth() + (fixture.displayedMonthOffset ?? 0) + navigations
      )
      return calendarDays(displayedMonth, true).some(day => localDateKey(day) === date)
    }
    const control = {
      async command(action, selector, options) {
        const date = selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)?.[1]
        if (action === 'getElementCount' && date) return String(dayVisible(date) ? 1 : 0)
        if (action === 'click' && /collaboration-schedule-next|下一个月/.test(selector))
          navigations++
        if (action === 'waitFor' && date) {
          expect([fixture.ranges[0].split(' → ')[0], fixture.target]).toContain(date)
          assert.ok(
            dayVisible(date),
            'The requested day must remain in the displayed calendar grid'
          )
          assert.equal(navigations, fixture.navigationCount, 'The target month was overshot')
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
    expect(rangeIndex).toBe(3)
  }
)
