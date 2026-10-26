import { afterEach, expect, test, vi } from 'vitest'
import {
  calendarDays,
  localDateKey,
} from '../../../packages/collaboration/src/project-schedule/model'
import { verifyCollaborationScheduleViews } from '../../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  {
    today: new Date(2026, 9, 19, 12),
    target: '2026-11-02',
    initialRange: '2026-10-26 → 2026-10-28',
    initiallyVisible: true,
  },
  {
    today: new Date(2026, 9, 26, 12),
    target: '2026-11-09',
    initialRange: '2026-11-02 → 2026-11-04',
    initiallyVisible: false,
  },
  {
    today: new Date(2026, 11, 28, 12),
    target: '2027-01-11',
    initialRange: '2027-01-04 → 2027-01-06',
    initiallyVisible: false,
  },
])('shows calendar target $target without navigating past it', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(fixture.today)
  let monthAdvances = 0
  const source = fixture.initialRange.split(' → ')[0]
  const waitedDates = new Set<string>()
  const dragReached = new Error('Calendar is ready for the drag assertion')
  const visibleDates = () =>
    new Set(
      calendarDays(
        new Date(fixture.today.getFullYear(), fixture.today.getMonth() + monthAdvances, 1),
        true
      ).map(localDateKey)
    )
  const targetVisible = () => visibleDates().has(fixture.target)
  const control = {
    async command(action: string, selector: string) {
      if (
        action === 'click' &&
        (selector.includes('collaboration-schedule-next') || selector.includes('下一个月'))
      ) {
        monthAdvances += 1
      }
      const day = selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)?.[1]
      if (action === 'getElementCount' && day) return visibleDates().has(day) ? 1 : 0
      if (action === 'getAttribute') return fixture.initialRange
      if (action === 'waitFor' && day) {
        expect([source, fixture.target]).toContain(day)
        expect(
          visibleDates().has(day),
          'Both drag dates must remain in the displayed month grid'
        ).toBe(true)
        waitedDates.add(day)
      }
      if (action === 'drag') {
        expect(targetVisible()).toBe(true)
        throw dragReached
      }
      return undefined
    },
  }

  await expect(
    verifyCollaborationScheduleViews({
      capture: async () => {},
      control,
      issueTitle: 'Calendar range regression',
      scoped: (selector: string) => selector,
      timeoutMs: 1000,
    })
  ).rejects.toBe(dragReached)
  expect(waitedDates).toEqual(new Set([source, fixture.target]))
  expect(monthAdvances).toBe(fixture.initiallyVisible ? 0 : 1)
})
