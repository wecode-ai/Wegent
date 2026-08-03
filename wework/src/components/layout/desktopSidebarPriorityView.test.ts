import { describe, expect, test } from 'vitest'
import {
  createDesktopSidebarPrioritySession,
  reconcileDesktopSidebarPrioritySession,
  selectDesktopSidebarPriorityView,
  type DesktopSidebarPrioritySource,
} from './desktopSidebarPriorityView'

interface TestItem {
  key: string
}

const activatedAt = new Date('2026-08-03T12:00:00').getTime()

function source(
  key: string,
  overrides: Partial<DesktopSidebarPrioritySource<TestItem>> = {}
): DesktopSidebarPrioritySource<TestItem> {
  return {
    key,
    item: { key },
    pinned: false,
    pinnedOrder: Number.MAX_SAFE_INTEGER,
    priorityRank: null,
    recencyAt: new Date('2026-08-03T10:00:00').getTime(),
    ...overrides,
  }
}

describe('desktopSidebarPriorityView', () => {
  test('keeps an opened unread item in priority for the active filter session', () => {
    const unread = source('unread', { priorityRank: 0 })
    const session = createDesktopSidebarPrioritySession([unread], false, activatedAt)
    const reconciled = reconcileDesktopSidebarPrioritySession(session, [source('unread')], false)

    expect(selectDesktopSidebarPriorityView(reconciled, [source('unread')], false)).toMatchObject({
      priorityItems: [{ key: 'unread' }],
      recentGroups: [],
    })
  })

  test('keeps recent placement stable and appends newly urgent items to priority', () => {
    const recent = source('recent')
    const session = createDesktopSidebarPrioritySession([recent], false, activatedAt)
    const sources = [
      source('recent', { priorityRank: 0 }),
      source('new-priority', { priorityRank: 1 }),
    ]
    const reconciled = reconcileDesktopSidebarPrioritySession(session, sources, false)
    const view = selectDesktopSidebarPriorityView(reconciled, sources, false)

    expect(view.priorityItems).toEqual([{ key: 'new-priority' }])
    expect(view.recentGroups[0]?.items).toEqual([{ key: 'recent' }])
  })

  test('groups the last seven days and excludes older items', () => {
    const session = createDesktopSidebarPrioritySession(
      [
        source('today'),
        source('yesterday', { recencyAt: new Date('2026-08-02T09:00:00').getTime() }),
        source('weekday', { recencyAt: new Date('2026-07-29T09:00:00').getTime() }),
        source('old', { recencyAt: new Date('2026-07-27T23:59:59').getTime() }),
      ],
      false,
      activatedAt
    )
    const view = selectDesktopSidebarPriorityView(
      session,
      [
        source('today'),
        source('yesterday', { recencyAt: new Date('2026-08-02T09:00:00').getTime() }),
        source('weekday', { recencyAt: new Date('2026-07-29T09:00:00').getTime() }),
        source('old', { recencyAt: new Date('2026-07-27T23:59:59').getTime() }),
      ],
      false
    )

    expect(view.recentGroups.map(group => group.relativeDay)).toEqual([
      'today',
      'yesterday',
      'weekday',
    ])
    expect(view.recentGroups.flatMap(group => group.items)).not.toContainEqual({ key: 'old' })
  })

  test('moves pinned items into a separate section only while the option is enabled', () => {
    const pinnedPriority = source('pinned-priority', {
      pinned: true,
      pinnedOrder: 0,
      priorityRank: 1,
    })
    const session = createDesktopSidebarPrioritySession([pinnedPriority], false, activatedAt)

    expect(selectDesktopSidebarPriorityView(session, [pinnedPriority], false)).toMatchObject({
      pinnedItems: [],
      priorityItems: [{ key: 'pinned-priority' }],
    })
    expect(selectDesktopSidebarPriorityView(session, [pinnedPriority], true)).toMatchObject({
      pinnedItems: [{ key: 'pinned-priority' }],
      priorityItems: [],
    })
  })

  test('removes archived items and preserves the order of surviving priority items', () => {
    const first = source('first', { priorityRank: 0 })
    const second = source('second', { priorityRank: 1 })
    const session = createDesktopSidebarPrioritySession([first, second], false, activatedAt)
    const reconciled = reconcileDesktopSidebarPrioritySession(session, [second], false)

    expect(selectDesktopSidebarPriorityView(reconciled, [second], false).priorityItems).toEqual([
      { key: 'second' },
    ])
  })
})
