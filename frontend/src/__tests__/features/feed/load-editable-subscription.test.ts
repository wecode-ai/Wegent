// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { subscriptionApis } from '@/apis/subscription'
import { loadEditableSubscription } from '@/features/feed/components/subscription-form/load-editable-subscription'
import type { Subscription } from '@/types/subscription'

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getSubscription: jest.fn(),
  },
}))

const mockedGetSubscription = subscriptionApis.getSubscription as jest.MockedFunction<
  typeof subscriptionApis.getSubscription
>

const LIST_ITEM = {
  id: 42,
  display_name: 'Digest',
  prompt_template: '',
} as Subscription

describe('loadEditableSubscription', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the stored record so the editor opens with the saved prompt', async () => {
    const stored = {
      id: 42,
      display_name: 'Digest',
      prompt_template: 'Summarize {{date}}',
    } as Subscription
    mockedGetSubscription.mockResolvedValue(stored)

    await expect(loadEditableSubscription(LIST_ITEM)).resolves.toBe(stored)
    expect(mockedGetSubscription).toHaveBeenCalledWith(42)
  })

  it('rejects a failed detail request instead of editing a stale list item', async () => {
    mockedGetSubscription.mockRejectedValue(new Error('network down'))

    await expect(loadEditableSubscription(LIST_ITEM)).rejects.toThrow('network down')
  })
})
