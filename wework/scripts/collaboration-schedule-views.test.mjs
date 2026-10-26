import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  calendarDays,
  startOfScheduleWeek,
} from '../../packages/collaboration/src/project-schedule/model'
import { scheduleStartDate } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

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
