import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'
import {
  calendarDays,
  localDateKey,
} from '../../packages/collaboration/src/project-schedule/model.ts'
import { verifyCollaborationScheduleViews } from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  { today: new Date(2026, 9, 19, 12), start: '2026-10-26', target: '2026-11-02', next: 0 },
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
  const control = {
    async command(action, selector, options) {
      if (action === 'getElementCount' && selector.includes(target))
        return String(navigations === fixture.navigationCount ? 1 : 0)
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
