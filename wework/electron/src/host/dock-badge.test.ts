import { describe, expect, test, vi } from 'vitest'
import { syncDockBadge } from './dock-badge.js'

function createDock() {
  let badge = ''
  return {
    getBadge: () => badge,
    setBadge: vi.fn((value: string) => {
      badge = value
    }),
  }
}

describe('syncDockBadge', () => {
  test('counts unread completions and clears the badge after all tasks are read', () => {
    const dock = createDock()
    for (const count of [0, 1, 2, 2, 1, 0]) syncDockBadge(dock, count)

    expect(dock.setBadge.mock.calls).toEqual([['1'], ['2'], ['1'], ['']])
    expect(dock.getBadge()).toBe('')
  })

  test('shows unread counts before the existing development instance badge', () => {
    const dock = createDock()
    for (const count of [0, 2, 0]) syncDockBadge(dock, count, 'a1b2')

    expect(dock.setBadge.mock.calls).toEqual([['a1b2'], ['2'], ['a1b2']])
  })

  test('does nothing on platforms without a Dock', () => {
    expect(() => syncDockBadge(undefined, 2)).not.toThrow()
  })
})
