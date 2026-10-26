import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

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
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1, 12)
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
      if (action === 'click' && selector.includes('collaboration-schedule-')) {
        navigation.push(selector)
        if (selector.includes('today')) visibleMonth = today
        else if (selector.includes('next')) visibleMonth = nextMonth
        else assert.fail(`Unexpected calendar navigation: ${selector}`)
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
