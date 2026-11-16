// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { validAnalyticsRange } from './siteAnalyticsDates'

describe('site analytics calendar', () => {
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
