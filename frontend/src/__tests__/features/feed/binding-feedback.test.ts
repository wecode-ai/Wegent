// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { shouldShowPrivateBindingSuccessToast } from '@/features/feed/components/subscription-form/binding-feedback'

describe('shouldShowPrivateBindingSuccessToast', () => {
  test('returns true when private binding completes while waiting', () => {
    expect(
      shouldShowPrivateBindingSuccessToast(
        {
          channel_id: 410,
          private_bound: true,
          group_bound: false,
          completed: true,
          status: 'success',
        },
        true
      )
    ).toBe(true)
  })

  test('returns false when the frontend was not waiting', () => {
    expect(
      shouldShowPrivateBindingSuccessToast(
        {
          channel_id: 410,
          private_bound: true,
          group_bound: false,
          completed: true,
          status: 'success',
        },
        false
      )
    ).toBe(false)
  })

  test('returns false for group-only completion', () => {
    expect(
      shouldShowPrivateBindingSuccessToast(
        {
          channel_id: 410,
          private_bound: false,
          group_bound: true,
          completed: true,
          status: 'success',
        },
        true
      )
    ).toBe(false)
  })
})
