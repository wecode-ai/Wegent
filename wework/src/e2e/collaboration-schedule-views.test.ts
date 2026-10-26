import { afterEach, expect, test, vi } from 'vitest'
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
  const visibleDates: string[] = []
  const initialStart = fixture.initialRange.split(' → ')[0]
  const dragReached = new Error('Calendar is ready for the drag assertion')
  const targetVisible = () => (fixture.initiallyVisible ? monthAdvances === 0 : monthAdvances === 1)
  const control = {
    async command(action: string, selector: string) {
      if (
        action === 'click' &&
        (selector.includes('collaboration-schedule-next') || selector.includes('下一个月'))
      ) {
        monthAdvances += 1
      }
      if (action === 'getElementCount') return targetVisible() ? 1 : 0
      if (action === 'getAttribute') return fixture.initialRange
      if (action === 'waitFor' && selector.includes('collaboration-calendar-day-')) {
        const date = selector.match(/collaboration-calendar-day-(\d{4}-\d{2}-\d{2})/)?.[1] ?? ''
        expect([initialStart, fixture.target]).toContain(date)
        expect(targetVisible(), 'The target day must remain in the displayed month grid').toBe(true)
        visibleDates.push(date)
      }
      if (action === 'drag') {
        expect(targetVisible()).toBe(true)
        expect(visibleDates).toEqual([initialStart, fixture.target])
        expect(selector).toContain('collaboration-calendar-issue-')
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
  expect(monthAdvances).toBe(fixture.initiallyVisible ? 0 : 1)
})
