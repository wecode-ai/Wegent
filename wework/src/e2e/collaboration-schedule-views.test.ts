import { afterEach, expect, test, vi } from 'vitest'
import { calendarDays } from '../../../packages/collaboration/src/project-schedule/model'
import { verifyCollaborationScheduleViews } from '../../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  {
    today: new Date(2026, 9, 19, 12),
    target: '2026-11-02',
    initialRange: '2026-10-26 → 2026-10-28',
    displayedMonth: new Date(2026, 9, 1, 12),
    expectedMonthAdvances: 0,
  },
  {
    today: new Date(2026, 9, 26, 12),
    target: '2026-11-02',
    initialRange: '2026-10-26 → 2026-10-28',
    displayedMonth: new Date(2026, 9, 1, 12),
    expectedMonthAdvances: 0,
  },
  {
    today: new Date(2026, 11, 28, 12),
    target: '2027-01-04',
    initialRange: '2026-12-28 → 2026-12-30',
    displayedMonth: new Date(2026, 11, 1, 12),
    expectedMonthAdvances: 0,
  },
  {
    today: new Date(2026, 9, 26, 12),
    target: '2026-11-02',
    initialRange: '2026-10-26 → 2026-10-28',
    displayedMonth: new Date(2026, 8, 1, 12),
    expectedMonthAdvances: 1,
  },
])('shows calendar target $target without navigating past it', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(fixture.today)
  let monthAdvances = 0
  const dragReached = new Error('Calendar is ready for the drag assertion')
  const dayVisible = (selectedDate: string) => {
    const month = new Date(fixture.displayedMonth)
    month.setMonth(month.getMonth() + monthAdvances)
    return calendarDays(month, true).some(day => {
      const date = [day.getFullYear(), day.getMonth() + 1, day.getDate()]
        .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, '0')))
        .join('-')
      return date === selectedDate
    })
  }
  const control = {
    async command(action: string, selector: string) {
      if (
        action === 'click' &&
        (selector.includes('collaboration-schedule-next') || selector.includes('下一个月'))
      ) {
        monthAdvances += 1
      }
      if (action === 'getElementCount') return dayVisible(fixture.target) ? 1 : 0
      if (action === 'getAttribute') return fixture.initialRange
      if (action === 'waitFor' && selector.includes('collaboration-calendar-day-')) {
        const selectedDate = selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)?.[1]
        expect([fixture.initialRange.split(' → ')[0], fixture.target]).toContain(selectedDate)
        expect(
          dayVisible(selectedDate!),
          'The requested day must remain in the displayed month grid'
        ).toBe(true)
      }
      if (action === 'drag') {
        expect(dayVisible(fixture.target)).toBe(true)
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
  expect(monthAdvances).toBe(fixture.expectedMonthAdvances)
})
