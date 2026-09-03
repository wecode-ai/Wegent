import { describe, expect, test } from 'vitest'
import { formatUTC8DateTime } from './utc-date'

describe('formatUTC8DateTime', () => {
  test('treats backend timestamps without a timezone as UTC', () => {
    expect(formatUTC8DateTime('2026-09-01T04:00:00.585928')).toBe('2026-09-01 12:00:00')
  })

  test('normalizes timestamps with explicit zones to UTC+8', () => {
    expect(formatUTC8DateTime('2026-09-01T04:00:00Z')).toBe('2026-09-01 12:00:00')
    expect(formatUTC8DateTime('2026-09-01T12:00:00+08:00')).toBe('2026-09-01 12:00:00')
  })

  test('returns the requested fallback for missing or invalid timestamps', () => {
    expect(formatUTC8DateTime(undefined)).toBe('-')
    expect(formatUTC8DateTime('invalid', '--')).toBe('--')
  })
})
