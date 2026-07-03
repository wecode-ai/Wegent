import { describe, expect, test } from 'vitest'
import { formatRelativeSidebarTime } from './runtimeSidebarTime'

describe('runtimeSidebarTime', () => {
  test('formats relative sidebar time from the supplied clock', () => {
    const now = new Date('2026-07-03T12:00:00.000Z').getTime()

    expect(formatRelativeSidebarTime('2026-07-03T11:59:30.000Z', now)).toBe('1m')
    expect(formatRelativeSidebarTime('2026-07-03T11:58:00.000Z', now)).toBe('2m')
    expect(formatRelativeSidebarTime('2026-07-03T10:00:00.000Z', now)).toBe('2h')
    expect(formatRelativeSidebarTime('2026-07-01T12:00:00.000Z', now)).toBe('2d')
    expect(formatRelativeSidebarTime('2026-06-12T12:00:00.000Z', now)).toBe('3w')
  })

  test('returns an empty string for missing or invalid values', () => {
    expect(formatRelativeSidebarTime()).toBe('')
    expect(formatRelativeSidebarTime('not-a-date')).toBe('')
  })
})
