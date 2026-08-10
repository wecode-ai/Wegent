// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  formatAspectRatioLimit,
  formatVideoPixelLimit,
} from '@/features/tasks/components/chat/generationFormatting'

describe('generationFormatting', () => {
  it('formats aspect-ratio limits for users', () => {
    expect(formatAspectRatioLimit(2)).toBe('2:1')
    expect(formatAspectRatioLimit(0.5)).toBe('1:2')
  })

  it('formats standard and custom video pixel limits', () => {
    expect(formatVideoPixelLimit(1280 * 720)).toBe('720P')
    expect(formatVideoPixelLimit(1_500_000)).toBe('1.5 MP')
  })
})
