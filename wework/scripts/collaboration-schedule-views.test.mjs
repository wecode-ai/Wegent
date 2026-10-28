import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'
import {
  addLocalDays,
  calendarDays,
  localDateKey,
  startOfScheduleWeek,
} from '../../packages/collaboration/src/project-schedule/model.ts'
import {
  collaborationScheduleDates,
  ensureCalendarScheduleDatesVisible,
  verifyCollaborationScheduleViews,
} from '../e2e/desktop/modules/collaboration-schedule-views.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const CALENDAR = scoped('[data-testid="collaboration-calendar"]')
const GRID_DAYS = `${CALENDAR} [data-testid^="collaboration-calendar-day-"]`
const NEXT_MONTH = `${CALENDAR} [data-testid="collaboration-schedule-next"]`
const TIMEOUT_MS = 10_000

afterEach(() => vi.useRealTimers())

function localDate(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

function calendarControl(today, unavailableDates = new Set(), displayedMonthOffset = 0) {
  let month = new Date(today.getFullYear(), today.getMonth() + displayedMonthOffset, 1)
  const calls = []
  const visibleDates = () => new Set(calendarDays(month, true).map(localDateKey))
  return {
    calls,
    visibleDates,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'waitFor' && selector === GRID_DAYS) {
        assert.deepEqual(options, { visible: true, timeoutMs: TIMEOUT_MS })
        return ''
      }
      if (action === 'clickWhenEnabled' || action === 'click') {
        assert.equal(selector, NEXT_MONTH, 'Navigate through the visible calendar toolbar')
        month = new Date(month.getFullYear(), month.getMonth() + 1, 1)
        return ''
      }
      assert.ok(selector.startsWith(`${CALENDAR} `), 'Date queries must stay calendar-scoped')
      const key = selector.match(
        /\[data-testid="collaboration-calendar-day-(\d{4}-\d{2}-\d{2})"\]$/
      )?.[1]
      assert.ok(key, `Unexpected calendar date selector: ${selector}`)
      const visible = visibleDates().has(key) && !unavailableDates.has(key)
      if (action === 'getElementCount') return visible ? '1' : '0'
      if (action === 'waitFor') {
        assert.deepEqual(options, { visible: true, timeoutMs: TIMEOUT_MS })
        if (!visible) throw new Error(`Calendar date is not visible: ${key}`)
        return ''
      }
      throw new Error(`Unexpected calendar action: ${action}`)
    },
  }
}

const cases = [
  ['2026-10-25', '2026-10-19', '2026-10-26', 0],
  ['2026-10-26', '2026-10-26', '2026-11-02', 0],
  ['2026-05-18', '2026-05-18', '2026-05-25', 0],
  ['2026-08-31', '2026-08-24', '2026-08-31', 0],
  ['2026-12-28', '2026-12-28', '2027-01-04', 0],
  ['2024-02-26', '2024-02-26', '2024-03-04', 0],
]

test.each(cases)(
  'keeps the calendar drag source and destination visible on %s',
  async (todayKey, initialStart, calendarStart, nextMonthCount) => {
    const today = localDate(todayKey)
    const originalTime = today.getTime()
    const keys = collaborationScheduleDates(today)
    assert.equal(today.getTime(), originalTime, 'Date fixtures must not mutate their clock input')
    assert.deepEqual(keys, {
      initialStart,
      initialEnd: localDateKey(addLocalDays(localDate(initialStart), 2)),
      calendarStart,
      calendarEnd: localDateKey(addLocalDays(localDate(calendarStart), 2)),
      resizedEnd: localDateKey(addLocalDays(localDate(calendarStart), 3)),
      movedStart: localDateKey(addLocalDays(localDate(calendarStart), 2)),
      movedEnd: localDateKey(addLocalDays(localDate(calendarStart), 5)),
    })
    const control = calendarControl(today)

    await ensureCalendarScheduleDatesVisible({ control, scoped, keys, timeoutMs: TIMEOUT_MS })

    assert.equal(
      control.calls.filter(({ selector }) => selector === NEXT_MONTH).length,
      nextMonthCount
    )
    const waitedDates = control.calls
      .filter(({ action, selector }) => action === 'waitFor' && selector !== GRID_DAYS)
      .map(({ selector }) => selector.match(/day-(\d{4}-\d{2}-\d{2})/)?.[1])
    assert.deepEqual(new Set(waitedDates), new Set([initialStart, calendarStart]))
    assert.ok(control.visibleDates().has(initialStart))
    assert.ok(control.visibleDates().has(calendarStart))
  }
)

test('navigates once when both drag dates are only visible together in the next month', async () => {
  const control = calendarControl(localDate('2026-10-26'))
  const keys = { initialStart: '2026-11-02', calendarStart: '2026-11-09' }

  await ensureCalendarScheduleDatesVisible({ control, scoped, keys, timeoutMs: TIMEOUT_MS })

  assert.equal(control.calls.filter(({ selector }) => selector === NEXT_MONTH).length, 1)
  assert.ok(control.visibleDates().has(keys.initialStart))
  assert.ok(control.visibleDates().has(keys.calendarStart))
})

test('retains the current month when switching to the destination month would hide the source', async () => {
  const today = localDate('2026-05-18')
  const keys = { initialStart: '2026-05-25', calendarStart: '2026-06-01' }
  const juneDates = new Set(calendarDays(localDate('2026-06-01'), true).map(localDateKey))
  assert.equal(juneDates.has(keys.initialStart), false)
  assert.equal(juneDates.has(keys.calendarStart), true)
  const control = calendarControl(today)

  await ensureCalendarScheduleDatesVisible({ control, scoped, keys, timeoutMs: TIMEOUT_MS })

  assert.ok(control.calls.every(({ selector }) => selector !== NEXT_MONTH))
  assert.ok(control.visibleDates().has(keys.initialStart))
  assert.ok(control.visibleDates().has(keys.calendarStart))
})

test.each([
  ['initialStart', '2026-10-25'],
  ['calendarStart', '2026-10-26'],
])('fails when %s remains missing after month navigation', async (missingKey, todayKey) => {
  const today = localDate(todayKey)
  const keys = collaborationScheduleDates(today)
  const control = calendarControl(today, new Set([keys[missingKey]]))

  await assert.rejects(
    ensureCalendarScheduleDatesVisible({ control, scoped, keys, timeoutMs: TIMEOUT_MS }),
    new RegExp(`Calendar date is not visible: ${keys[missingKey]}`)
  )

  assert.equal(control.calls.filter(({ selector }) => selector === NEXT_MONTH).length, 1)
})

test('uses the supplied local Monday near midnight instead of its UTC date', () => {
  const keys = collaborationScheduleDates(new Date(2026, 9, 26, 0, 30))

  assert.equal(keys.initialStart, '2026-10-26')
  assert.equal(keys.calendarStart, '2026-11-02')
})

test('keeps every fixture inside the real calendar and Gantt windows throughout leap and ordinary years', async () => {
  for (
    let today = localDate('2024-01-01');
    today < localDate('2029-01-01');
    today = addLocalDays(today, 1)
  ) {
    const keys = collaborationScheduleDates(today)
    const control = calendarControl(today)

    await ensureCalendarScheduleDatesVisible({ control, scoped, keys, timeoutMs: TIMEOUT_MS })

    assert.ok(control.calls.filter(({ selector }) => selector === NEXT_MONTH).length <= 1)
    for (const key of ['initialStart', 'initialEnd', 'calendarStart', 'calendarEnd']) {
      assert.ok(control.visibleDates().has(keys[key]), `${localDateKey(today)}: calendar ${key}`)
    }
    const ganttStart = startOfScheduleWeek(today, true)
    const ganttDays = new Set(
      Array.from({ length: 28 }, (_, index) => localDateKey(addLocalDays(ganttStart, index)))
    )
    for (const name of ['calendarStart', 'calendarEnd', 'resizedEnd', 'movedStart', 'movedEnd']) {
      assert.ok(ganttDays.has(keys[name]), `${localDateKey(today)}: Gantt ${name}`)
    }
  }
})

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
  ...[
    {
      today: '2026-10-26T12:00:00',
      target: '2026-11-02',
      ranges: [
        '2026-10-26 → 2026-10-28',
        '2026-11-02 → 2026-11-04',
        '2026-11-02 → 2026-11-05',
        '2026-11-04 → 2026-11-07',
      ],
    },
    {
      today: '2026-12-28T12:00:00',
      target: '2027-01-04',
      ranges: [
        '2026-12-28 → 2026-12-30',
        '2027-01-04 → 2027-01-06',
        '2027-01-04 → 2027-01-07',
        '2027-01-06 → 2027-01-09',
      ],
    },
  ].map(fixture => ({ ...fixture, navigationCount: 1, displayedMonthOffset: -1 })),
])('keeps the target date visible when scheduling from $today', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(fixture.today))
  const calendar = calendarControl(
    new Date(fixture.today),
    new Set(),
    fixture.displayedMonthOffset ?? 0
  )
  let rangeIndex = 0
  const control = {
    async command(action, selector, options) {
      if (selector.endsWith('[data-testid^="collaboration-calendar-day-"]')) {
        return calendar.command(action, GRID_DAYS, options)
      }
      if (
        (action === 'getElementCount' || action === 'waitFor') &&
        selector.includes('collaboration-calendar-day-')
      ) {
        const day = selector.match(/\[data-testid="collaboration-calendar-day-[^"]+"\]/)?.[0]
        return calendar.command(action, `${CALENDAR} ${day}`, options)
      }
      if (action === 'click' && /collaboration-schedule-next|下一个月/.test(selector)) {
        return calendar.command(action, NEXT_MONTH, options)
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
    scoped,
    timeoutMs: TIMEOUT_MS,
  })

  expect(calendar.calls.filter(({ selector }) => selector === NEXT_MONTH)).toHaveLength(
    fixture.navigationCount
  )
  expect(calendar.visibleDates().has(fixture.target)).toBe(true)
  expect(
    calendar.calls
      .filter(({ action, selector }) => action === 'waitFor' && selector !== GRID_DAYS)
      .map(({ selector }) => selector)
  ).toEqual([
    `${CALENDAR} [data-testid="collaboration-calendar-day-${fixture.ranges[0].split(' → ')[0]}"]`,
    `${CALENDAR} [data-testid="collaboration-calendar-day-${fixture.target}"]`,
  ])
  expect(rangeIndex).toBe(3)
})

test('waits for mounted calendar days before deciding whether to change months', async () => {
  const today = localDate('2026-05-18')
  const calendar = calendarControl(today)
  let mounted = false
  const control = {
    async command(action, selector, options) {
      if (action === 'getElementCount' && !mounted) return '0'
      if (action === 'waitFor') mounted = true
      return calendar.command(action, selector, options)
    },
  }

  await ensureCalendarScheduleDatesVisible({
    control,
    scoped,
    keys: collaborationScheduleDates(today),
    timeoutMs: TIMEOUT_MS,
  })

  assert.equal(calendar.calls.filter(({ selector }) => selector === NEXT_MONTH).length, 0)
  assert.equal(calendar.calls[0].selector, GRID_DAYS)
})
