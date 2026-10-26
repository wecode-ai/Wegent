import { expect, test } from 'vitest'
import { verifyCollaborationScheduleViews } from '../../e2e/desktop/modules/collaboration-schedule-views.mjs'

test.each([
  {
    today: new Date(2026, 9, 19, 12),
    target: '2026-11-02',
    initialRange: '2026-10-26 → 2026-10-28',
    initiallyVisible: true,
    scheduleKeys: {
      initialStart: '2026-10-26',
      initialEnd: '2026-10-28',
      calendarStart: '2026-11-02',
      calendarEnd: '2026-11-04',
      resizedEnd: '2026-11-05',
      movedStart: '2026-11-04',
      movedEnd: '2026-11-07',
    },
  },
  {
    today: new Date(2026, 9, 26, 12),
    target: '2026-11-09',
    initialRange: '2026-11-02 → 2026-11-04',
    initiallyVisible: false,
    scheduleKeys: {
      initialStart: '2026-11-02',
      initialEnd: '2026-11-04',
      calendarStart: '2026-11-09',
      calendarEnd: '2026-11-11',
      resizedEnd: '2026-11-12',
      movedStart: '2026-11-11',
      movedEnd: '2026-11-14',
    },
  },
  {
    today: new Date(2026, 11, 28, 12),
    target: '2027-01-11',
    initialRange: '2027-01-04 → 2027-01-06',
    initiallyVisible: false,
    scheduleKeys: {
      initialStart: '2027-01-04',
      initialEnd: '2027-01-06',
      calendarStart: '2027-01-11',
      calendarEnd: '2027-01-13',
      resizedEnd: '2027-01-14',
      movedStart: '2027-01-13',
      movedEnd: '2027-01-16',
    },
  },
])('shows calendar target $target without navigating past it', async fixture => {
  let monthAdvances = 0
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
        expect(selector).toContain(fixture.target)
        expect(targetVisible(), 'The target day must remain in the displayed month grid').toBe(true)
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
      scheduleKeys: fixture.scheduleKeys,
      scoped: (selector: string) => selector,
      timeoutMs: 1000,
    })
  ).rejects.toBe(dragReached)
  expect(monthAdvances).toBe(fixture.initiallyVisible ? 0 : 1)
})
