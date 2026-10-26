import assert from 'node:assert/strict'
import { expect, test } from 'vitest'
import { verifyCollaborationScheduleViews } from '../e2e/desktop/modules/collaboration-schedule-verification.mjs'

test.each([
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
])('keeps the target date visible when scheduling from $today', async fixture => {
  let navigations = 0
  let rangeIndex = 0
  const target = `collaboration-calendar-day-${fixture.target}`
  const [initialStart, initialEnd] = fixture.ranges[0].split(' → ')
  const [calendarStart, calendarEnd] = fixture.ranges[1].split(' → ')
  const [, resizedEnd] = fixture.ranges[2].split(' → ')
  const [movedStart, movedEnd] = fixture.ranges[3].split(' → ')
  const control = {
    async command(action, selector, options) {
      if (action === 'getElementCount' && selector.includes(target))
        return String(navigations === fixture.navigationCount ? 1 : 0)
      if (action === 'click' && /collaboration-schedule-next|下一个月/.test(selector)) navigations++
      if (action === 'waitFor' && selector.includes(target))
        assert.equal(navigations, fixture.navigationCount, 'The target month was overshot')
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
    scheduleKeys: {
      initialStart,
      initialEnd,
      calendarStart,
      calendarEnd,
      resizedEnd,
      movedStart,
      movedEnd,
    },
    scoped: selector => selector,
    timeoutMs: 100,
  })

  expect(navigations).toBe(fixture.navigationCount)
  expect(rangeIndex).toBe(3)
})
