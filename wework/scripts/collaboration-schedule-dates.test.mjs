import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  collaborationScheduleDates,
  verifyCollaborationScheduleViews,
} from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

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

test.each(['2026-10-26T12:00:00', '2026-11-30T12:00:00'])(
  'the schedule scenario uses its generated dates throughout the flow on %s',
  async clock => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(clock))
    const keys = collaborationScheduleDates()
    const calls = []
    const captures = []
    let range = `${keys.initialStart} → ${keys.initialEnd}`
    let sorted = false
    const control = {
      async command(action, selector, options = {}) {
        calls.push({ action, selector, options })
        if (action === 'getElementCount') return '1'
        if (action === 'getAttribute') {
          if (options.value === 'title') return range
          assert.equal(options.value, 'aria-sort')
          assert.ok(sorted, 'The scenario must click the sort control before checking it')
          return 'ascending'
        }
        if (action === 'getValue') return 'status'
        if (action === 'getComputedStyleValue') return 'ew-resize'
        if (action === 'getText') return '开始时间 结束时间'
        if (action === 'drag') {
          if (selector.includes('collaboration-calendar-issue-')) {
            assert.equal(
              options.target,
              `[data-testid="collaboration-calendar-day-${keys.calendarStart}"]`
            )
            range = `${keys.calendarStart} → ${keys.calendarEnd}`
          } else {
            assert.ok(selector.includes('collaboration-gantt-issue-'))
            assert.ok(options.target.endsWith(`[data-testid$="-day-${keys.movedStart}"]`))
            range = `${keys.movedStart} → ${keys.movedEnd}`
          }
          return
        }
        if (action === 'dragBy') {
          assert.ok(selector.includes('-end-handle'))
          assert.deepEqual(JSON.parse(options.value), { x: 20, y: 0 })
          range = `${keys.calendarStart} → ${keys.resizedEnd}`
          return
        }
        if (action === 'click' && selector.includes('collaboration-issue-table-sort-title')) {
          sorted = true
        }
        assert.ok(
          [
            'setMainWindowSize',
            'click',
            'waitFor',
            'fill',
            'clickWhenEnabled',
            'select',
            'hover',
          ].includes(action),
          `Unexpected control action: ${action}`
        )
      },
    }
    await verifyCollaborationScheduleViews({
      capture: async (_, name) => captures.push(name),
      control,
      issueTitle: 'Schedule regression',
      scoped: selector => selector,
      timeoutMs: 1000,
    })
    assert.equal(range, `${keys.movedStart} → ${keys.movedEnd}`)
    assert.equal(calls.filter(call => call.action === 'drag').length, 2)
    assert.equal(calls.filter(call => call.action === 'dragBy').length, 1)
    assert.equal(captures.length, 3)
    const dayWaits = calls.filter(
      call => call.action === 'waitFor' && /collaboration-calendar-day-\d{4}/.test(call.selector)
    )
    assert.deepEqual(
      dayWaits.map(call => call.selector),
      [keys.initialStart, keys.calendarStart].map(
        day => `[data-testid="collaboration-calendar-day-${day}"]`
      )
    )
    const filterIndex = calls.findIndex(
      call =>
        call.action === 'select' && call.selector.includes('collaboration-calendar-status-filter')
    )
    assert.ok(
      dayWaits.every(call => calls.indexOf(call) < filterIndex),
      'Both source and target days must be visible before saving the calendar filters'
    )
    assert.equal(
      calls.some(call => /collaboration-schedule-next|下一个月/.test(call.selector)),
      false,
      'Generated source and target dates must stay visible together without month navigation'
    )
  }
)
