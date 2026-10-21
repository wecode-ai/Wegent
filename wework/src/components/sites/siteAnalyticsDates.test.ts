import { describe, expect, test } from 'vitest'
import { analyticsToday, recentAnalyticsRange, validAnalyticsRange } from './siteAnalyticsDates'

describe('site analytics calendar', () => {
  test('uses Beijing dates across UTC midnight and includes both endpoints', () => {
    expect(analyticsToday(new Date('2026-10-16T16:00:00Z'))).toBe('2026-10-17')
    expect(recentAnalyticsRange(31, '2026-10-17')).toEqual({
      start_date: '2026-09-17',
      end_date: '2026-10-17',
    })
    expect(validAnalyticsRange(recentAnalyticsRange(31, '2026-10-17'), '2026-10-17')).toBe(true)
    expect(validAnalyticsRange(recentAnalyticsRange(32, '2026-10-17'), '2026-10-17')).toBe(false)
    expect(
      validAnalyticsRange({ start_date: '2024-02-28', end_date: '2024-03-01' }, '2026-10-17')
    ).toBe(true)
  })
  test.each([
    ['', '2026-10-17'],
    ['2026-02-29', '2026-03-01'],
    ['2026-10-18', '2026-10-18'],
    ['2026-10-17', '2026-10-16'],
    ['2026-1-1', '2026-01-01'],
    ['0000-01-01', '0000-01-01'],
  ])('rejects invalid dates %s to %s', (start_date, end_date) => {
    expect(validAnalyticsRange({ start_date, end_date }, '2026-10-17')).toBe(false)
  })
})
