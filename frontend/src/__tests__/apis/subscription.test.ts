// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { subscriptionApis } from '@/apis/subscription'

jest.mock('@/apis/client', () => ({
  apiClient: {
    post: jest.fn(),
  },
}))

describe('subscriptionApis developer binding', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('starts developer binding for unsaved subscription via subscriptions prefix', async () => {
    ;(apiClient.post as jest.Mock).mockResolvedValue({
      channel_id: 410,
      bind_private: true,
      bind_group: true,
    })

    await subscriptionApis.startDeveloperBindingSession(null, {
      channel_id: 410,
      bind_private: true,
      bind_group: true,
    })

    expect(apiClient.post).toHaveBeenCalledWith('/subscriptions/developer/binding/start', {
      channel_id: 410,
      bind_private: true,
      bind_group: true,
    })
  })

  test('cancels developer binding for unsaved subscription via subscriptions prefix', async () => {
    ;(apiClient.post as jest.Mock).mockResolvedValue({
      channel_id: 410,
    })

    await subscriptionApis.cancelDeveloperBindingSession(null, {
      channel_id: 410,
    })

    expect(apiClient.post).toHaveBeenCalledWith('/subscriptions/developer/binding/cancel', {
      channel_id: 410,
    })
  })
})
