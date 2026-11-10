// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from '@testing-library/react'

import { subscriptionApis } from '@/apis/subscription'
import { SubscriptionProvider } from '@/features/feed/contexts/subscriptionContext'

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getSubscriptions: jest.fn(),
    getExecutions: jest.fn(),
  },
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ registerBackgroundExecutionHandlers: () => () => {} }),
}))

const mockedApis = subscriptionApis as jest.Mocked<typeof subscriptionApis>

describe('SubscriptionProvider initial load', () => {
  beforeEach(() => {
    mockedApis.getSubscriptions.mockResolvedValue({
      total: 0,
      items: [],
      invalid_schedule_count: 0,
    } as never)
    mockedApis.getExecutions.mockResolvedValue({
      total: 1,
      items: [{ id: 1, subscription_id: 1, status: 'COMPLETED' }],
    } as never)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('fetches the execution timeline once, not again after the first page arrives', async () => {
    render(
      <SubscriptionProvider>
        <div />
      </SubscriptionProvider>
    )

    await waitFor(() => expect(mockedApis.getExecutions).toHaveBeenCalledTimes(1))
    // Let the state update from the first response flush, then make sure no refetch followed.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mockedApis.getExecutions).toHaveBeenCalledTimes(1)
  })
})
