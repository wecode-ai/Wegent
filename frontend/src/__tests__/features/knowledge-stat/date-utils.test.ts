// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  enumerateDateRange,
  formatLocalDate,
  inclusiveDateCount,
} from '@/features/knowledge-stat/date-utils'

describe('knowledge-stat date utilities', () => {
  it('formats the browser local calendar date without converting to UTC', () => {
    const value = new Date(2026, 6, 27, 0, 30)

    expect(formatLocalDate(value)).toBe('2026-07-27')
  })

  it('counts calendar days inclusively across a month boundary', () => {
    expect(inclusiveDateCount('2026-07-30', '2026-08-02')).toBe(4)
  })

  it('enumerates leap-day ranges without timezone drift', () => {
    expect(enumerateDateRange('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ])
  })
})
