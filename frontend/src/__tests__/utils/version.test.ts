// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isVersionAtLeast } from '@/lib/utils'

describe('version utils', () => {
  test('accepts versions with a v prefix', () => {
    expect(isVersionAtLeast('v1.7.11', '1.7.11')).toBe(true)
    expect(isVersionAtLeast('1.7.11', 'v1.7.11')).toBe(true)
    expect(isVersionAtLeast('v1.7.10', 'v1.7.11')).toBe(false)
  })
})
