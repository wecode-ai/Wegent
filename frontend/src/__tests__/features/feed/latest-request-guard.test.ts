// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createLatestRequestGuard } from '@/features/feed/components/subscription-form/latest-request-guard'

describe('createLatestRequestGuard', () => {
  it('keeps only the newest request valid', () => {
    const guard = createLatestRequestGuard()
    const first = guard.begin()
    const second = guard.begin()

    expect(guard.isLatest(first)).toBe(false)
    expect(guard.isLatest(second)).toBe(true)
  })

  it('drops requests that were invalidated by a form reset', () => {
    const guard = createLatestRequestGuard()
    const request = guard.begin()

    guard.invalidate()

    expect(guard.isLatest(request)).toBe(false)
  })
})
