import { afterEach, expect, test, vi } from 'vitest'
import { verifyCollaborationScheduleViews } from '../../e2e/desktop/modules/collaboration-schedule-views.mjs'

afterEach(() => vi.useRealTimers())

test.each([
  {
    today: new Date(2026, 9, 19, 12),
    target: '2026-10-26',
    initialRange: '2026-10-19 → 2026-10-21',
  },
  {
    today: new Date(2026, 9, 26, 12),
    target: '2026-11-02',
    initialRange: '2026-10-26 → 2026-10-28',
  },
  {
    today: new Date(2026, 11, 28, 12),
    target: '2027-01-04',
    initialRange: '2026-12-28 → 2026-12-30',
  },
])('shows calendar target $target without navigating past it', async fixture => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(fixture.today)
  let monthAdvances = 0
  const dragReached = new Error('Calendar is ready for the drag assertion')
  const gridStart = new Date(fixture.today.getFullYear(), fixture.today.getMonth(), 1, 12)
  gridStart.setDate(1 - ((gridStart.getDay() + 6) % 7))
  const gridEnd = new Date(gridStart)
  gridEnd.setDate(gridEnd.getDate() + 41)
  const control = {
    async command(action: string, selector: string) {
      if (
        action === 'click' &&
        (selector.includes('collaboration-schedule-next') || selector.includes('下一个月'))
      ) {
        monthAdvances += 1
      }
      if (action === 'getAttribute') return fixture.initialRange
      if (action === 'waitFor' && selector.includes('collaboration-calendar-day-')) {
        expect(selector).toContain(fixture.target)
        const target = new Date(`${fixture.target}T12:00:00`)
        expect(target.getTime()).toBeGreaterThanOrEqual(gridStart.getTime())
        expect(target.getTime()).toBeLessThanOrEqual(gridEnd.getTime())
        expect(monthAdvances, 'The target day must remain in the displayed month grid').toBe(0)
      }
      if (action === 'drag') {
        expect(monthAdvances).toBe(0)
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
  expect(monthAdvances).toBe(0)
})
