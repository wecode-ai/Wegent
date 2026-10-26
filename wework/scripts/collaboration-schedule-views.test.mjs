import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'

import {
  calendarDays,
  localDateKey,
} from '../../packages/collaboration/src/project-schedule/model.ts'
import { verifyCollaborationScheduleViews } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  ...Array.from({ length: 12 }, (_, month) => new Date(2026, month, 1, 12)),
  ...Array.from({ length: 12 }, (_, month) => new Date(2026, month, 26, 12)),
  new Date(2026, 11, 31, 12),
  new Date(2027, 0, 31, 12),
  new Date(2028, 1, 29, 12),
])('keeps both drag ranges in the rendered calendar when run on %s', async today => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(today)
  let visibleMonth = today
  const dates = {}
  const navigation = []
  const reachedDrag = new Error('Reached the real calendar drag boundary')
  const renderedDates = () => new Set(calendarDays(visibleMonth, true).map(localDateKey))
  const control = {
    async command(action, selector, options) {
      if (action === 'fill') {
        if (selector.includes('start-date')) dates.start = options.value
        if (selector.includes('due-date')) dates.end = options.value
      }
      if (
        action === 'click' &&
        (selector.includes('collaboration-schedule-') ||
          selector.includes('[aria-label="下一个月"]'))
      ) {
        navigation.push(selector)
        if (selector.includes('today')) visibleMonth = today
        else if (selector.includes('next') || selector.includes('[aria-label="下一个月"]')) {
          visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1, 12)
        } else assert.fail(`Unexpected calendar navigation: ${selector}`)
      }
      if (action === 'getElementCount') {
        const target = selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)[1]
        return Number(renderedDates().has(target))
      }
      if (action === 'getAttribute') return `${dates.start} → ${dates.end}`
      if (action !== 'drag') return

      assert.ok(selector.includes('collaboration-calendar-issue-'))
      const target = options.target.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)[1]
      const start = new Date(`${dates.start}T12:00:00`)
      const end = new Date(`${dates.end}T12:00:00`)
      const movedStart = new Date(start)
      const movedEnd = new Date(end)
      movedStart.setDate(start.getDate() + 7)
      movedEnd.setDate(end.getDate() + 7)
      assert.equal(target, localDateKey(movedStart), 'Keep the full one-week calendar move')
      for (const date of [start, end, movedStart, movedEnd]) {
        assert.ok(
          renderedDates().has(localDateKey(date)),
          `${localDateKey(date)} is outside the calendar`
        )
      }
      assert.equal(start.getDay(), 1, 'Schedule starts on Monday')
      const expectedEnd = new Date(start)
      expectedEnd.setDate(start.getDate() + 2)
      assert.equal(dates.end, localDateKey(expectedEnd), 'Preserve the three-day task range')
      assert.ok(start > today, 'Keep the schedule in the future')
      throw reachedDrag
    },
  }

  await assert.rejects(
    verifyCollaborationScheduleViews({
      capture: async () => {},
      control,
      issueTitle: 'Schedule boundary regression',
      scoped: selector => selector,
      timeoutMs: 10_000,
    }),
    error => error === reachedDrag
  )
  const target = new Date(`${dates.start}T12:00:00`)
  target.setDate(target.getDate() + 7)
  const needsNextMonth = !calendarDays(today, true).map(localDateKey).includes(localDateKey(target))
  assert.deepEqual(navigation, [
    '[data-testid="collaboration-schedule-today"]',
    ...(needsNextMonth ? ['[data-testid="collaboration-schedule-next"]'] : []),
  ])
})

test.each([
  {
    today: '2026-10-19T12:00:00',
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
    today: '2026-10-26T12:00:00',
    target: '2026-11-09',
    navigationCount: 1,
    ranges: [
      '2026-11-02 → 2026-11-04',
      '2026-11-09 → 2026-11-11',
      '2026-11-09 → 2026-11-12',
      '2026-11-11 → 2026-11-14',
    ],
  },
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
  {
    today: '2026-12-28T12:00:00',
    target: '2027-01-11',
    navigationCount: 1,
    ranges: [
      '2027-01-04 → 2027-01-06',
      '2027-01-11 → 2027-01-13',
      '2027-01-11 → 2027-01-14',
      '2027-01-13 → 2027-01-16',
    ],
  },
])('keeps the target date visible when scheduling from $today', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(fixture.today))
  let navigations = 0
  let rangeIndex = 0
  const calendarDays = []
  const target = `collaboration-calendar-day-${fixture.target}`
  const expectedDaySelectors = [fixture.ranges[0].split(' → ')[0], fixture.target].map(
    day => `[data-testid="collaboration-calendar-day-${day}"]`
  )
  const control = {
    async command(action, selector, options) {
      if (action === 'getElementCount' && selector.includes(target))
        return String(navigations === fixture.navigationCount ? 1 : 0)
      if (action === 'click' && /collaboration-schedule-next|下一个月/.test(selector)) navigations++
      if (action === 'waitFor' && selector.includes('collaboration-calendar-day-')) {
        expect(selector).toBe(expectedDaySelectors[calendarDays.length])
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
  expect(calendarDays).toEqual(expectedDaySelectors)
  expect(rangeIndex).toBe(3)
})
