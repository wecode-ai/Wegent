import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  calendarDays,
  localDateKey,
} from '../../packages/collaboration/src/project-schedule/model.ts'
import { verifyCollaborationScheduleViews } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  { today: new Date(2026, 9, 25, 12), start: '2026-10-26', target: '2026-11-02', next: 0 },
  { today: new Date(2026, 9, 26, 12), start: '2026-11-02', target: '2026-11-09', next: 1 },
  { today: new Date(2026, 11, 28, 12), start: '2027-01-04', target: '2027-01-11', next: 1 },
  { today: new Date(2028, 1, 28, 12), start: '2028-03-06', target: '2028-03-13', next: 1 },
])('keeps the source and drag target visible for $start → $target', async fixture => {
  vi.useFakeTimers()
  vi.setSystemTime(fixture.today)
  let month = new Date(fixture.today.getFullYear(), fixture.today.getMonth(), 1)
  let nextClicks = 0
  const fields = new Map()
  const dragReached = new Error('Calendar drag reached')
  const visibleDates = () => new Set(calendarDays(month, true).map(localDateKey))
  const targetDate = selector =>
    selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)?.[1]
  const control = {
    async command(action, selector, options) {
      switch (action) {
        case 'setMainWindowSize':
        case 'clickWhenEnabled':
        case 'select':
          return ''
        case 'click':
          if (selector.includes('collaboration-schedule-next') || selector.includes('下一个月')) {
            nextClicks += 1
            month = new Date(month.getFullYear(), month.getMonth() + 1, 1)
          }
          return ''
        case 'fill':
          fields.set(selector, options.value)
          return ''
        case 'getAttribute':
          return `${fields.get('[data-testid="cloud-todo-detail-start-date"]')} → ${fields.get('[data-testid="cloud-todo-detail-due-date"]')}`
        case 'getElementCount':
          return String(Number(visibleDates().has(targetDate(selector))))
        case 'waitFor':
          if (targetDate(selector)) assert.ok(visibleDates().has(targetDate(selector)))
          return ''
        case 'drag':
          assert.equal(fields.get('[data-testid="cloud-todo-detail-start-date"]'), fixture.start)
          assert.equal(targetDate(options.target), fixture.target)
          assert.ok(visibleDates().has(fixture.start), 'The source left the calendar view')
          assert.ok(visibleDates().has(fixture.target), 'The target is outside the calendar view')
          throw dragReached
        default:
          assert.fail(`Unexpected calendar fixture command: ${action}`)
      }
    },
  }
  await assert.rejects(
    verifyCollaborationScheduleViews({
      capture: async () => {},
      control,
      issueTitle: 'Calendar boundary fixture',
      scoped: selector => selector,
      timeoutMs: 10_000,
    }),
    error => error === dragReached
  )
  assert.equal(nextClicks, fixture.next)
})
