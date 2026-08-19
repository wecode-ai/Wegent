// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { formatVideoTime } from '@wecode/features/knowledge/video-time'

describe('formatVideoTime', () => {
  it.each([
    [0, '0:00'],
    [65, '1:05'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3902, '1:05:02'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatVideoTime(seconds)).toBe(expected)
  })

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'normalizes invalid value %s',
    seconds => {
      expect(formatVideoTime(seconds)).toBe('0:00')
    }
  )
})
