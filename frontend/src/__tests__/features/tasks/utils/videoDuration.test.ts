// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { formatVideoDuration } from '@/features/tasks/utils/videoDuration'

describe('formatVideoDuration', () => {
  it('formats automatic duration without exposing the sentinel value', () => {
    expect(formatVideoDuration(-1, '智能时长')).toBe('智能时长')
  })

  it('formats fixed durations in seconds', () => {
    expect(formatVideoDuration(30, 'Auto')).toBe('30S')
  })

  it('omits missing durations', () => {
    expect(formatVideoDuration(undefined, 'Auto')).toBeUndefined()
  })
})
