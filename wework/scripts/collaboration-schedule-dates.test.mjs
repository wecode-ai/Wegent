import assert from 'node:assert/strict'
import { test } from 'vitest'
import { collaborationScheduleDates } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

test('calendar drag fixtures stay in the displayed month grid throughout leap and common years', () => {
  for (const year of [2024, 2026]) {
    for (let month = 0; month < 12; month += 1) {
      const first = new Date(year, month, 1, 12)
      const gridStart = addDays(first, -((first.getDay() + 6) % 7))
      const gridEnd = addDays(gridStart, 41)
      for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day += 1) {
        const today = new Date(year, month, day, 12)
        const before = today.getTime()
        const dates = collaborationScheduleDates(today)
        for (const key of ['initialStart', 'initialEnd', 'calendarStart', 'calendarEnd']) {
          const date = new Date(`${dates[key]}T12:00:00`)
          assert.ok(date >= gridStart && date <= gridEnd, `${today}: ${key} outside month grid`)
        }
        const ganttStart = addDays(today, -((today.getDay() + 6) % 7))
        for (const key of ['calendarStart', 'resizedEnd', 'movedStart', 'movedEnd']) {
          const date = new Date(`${dates[key]}T12:00:00`)
          assert.ok(
            date >= ganttStart && date <= addDays(ganttStart, 27),
            `${today}: ${key} outside Gantt window`
          )
        }
        assert.equal(today.getTime(), before, 'The fixture must not mutate its clock input')
      }
    }
  }
})

test('the failing end-of-month Monday drags to the next visible week', () => {
  assert.deepEqual(collaborationScheduleDates(new Date(2026, 9, 26, 12)), {
    initialStart: '2026-10-26',
    initialEnd: '2026-10-28',
    calendarStart: '2026-11-02',
    calendarEnd: '2026-11-04',
    resizedEnd: '2026-11-05',
    movedStart: '2026-11-04',
    movedEnd: '2026-11-07',
  })
})
