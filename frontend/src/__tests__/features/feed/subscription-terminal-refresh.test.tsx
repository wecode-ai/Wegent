// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen, waitFor } from '@testing-library/react'

import { subscriptionApis } from '@/apis/subscription'
import {
  SubscriptionProvider,
  useSubscriptionContext,
} from '@/features/feed/contexts/subscriptionContext'
import type { BackgroundExecutionUpdatePayload } from '@/types/socket'
import type { Subscription } from '@/types/subscription'

let mockExecutionUpdate: ((payload: BackgroundExecutionUpdatePayload) => void) | undefined

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    registerBackgroundExecutionHandlers: (handlers: {
      onBackgroundExecutionUpdate: (payload: BackgroundExecutionUpdatePayload) => void
    }) => {
      mockExecutionUpdate = handlers.onBackgroundExecutionUpdate
      return jest.fn()
    },
  }),
}))

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getSubscriptions: jest.fn(),
    getExecutions: jest.fn(),
  },
}))

const SUBSCRIPTION = {
  id: 12,
  execution_count: 0,
} as Subscription

function ExecutionCount() {
  const { subscriptions } = useSubscriptionContext()
  return <span>{subscriptions[0]?.execution_count ?? 'loading'}</span>
}

const executionUpdate = (
  status: BackgroundExecutionUpdatePayload['status']
): BackgroundExecutionUpdatePayload => ({
  execution_id: 90,
  subscription_id: 12,
  subscription_name: 'code-wiki-34',
  subscription_display_name: 'Wegent Wiki',
  status,
  is_silent: status === 'COMPLETED_SILENT',
  task_id: 56,
  task_type: 'execution',
  created_at: '2026-09-16T01:00:00',
  updated_at: '2026-09-16T02:00:00',
})

describe('subscription summary refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExecutionUpdate = undefined
    jest
      .mocked(subscriptionApis.getSubscriptions)
      .mockResolvedValueOnce({
        items: [SUBSCRIPTION],
        total: 1,
        invalid_schedule_count: 0,
      })
      .mockResolvedValue({
        items: [{ ...SUBSCRIPTION, execution_count: 1 }],
        total: 1,
        invalid_schedule_count: 0,
      })
    jest.mocked(subscriptionApis.getExecutions).mockResolvedValue({ items: [], total: 0 })
  })

  it('reloads My subscriptions after a terminal execution, but not while it is running', async () => {
    render(
      <SubscriptionProvider>
        <ExecutionCount />
      </SubscriptionProvider>
    )

    expect(await screen.findByText('0')).toBeInTheDocument()
    expect(mockExecutionUpdate).toBeDefined()

    act(() => mockExecutionUpdate?.(executionUpdate('RUNNING')))
    expect(subscriptionApis.getSubscriptions).toHaveBeenCalledTimes(1)

    act(() => mockExecutionUpdate?.(executionUpdate('COMPLETED')))

    await waitFor(() => expect(subscriptionApis.getSubscriptions).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('1')).toBeInTheDocument()
  })

  it('keeps the newest subscription response when terminal events overlap', async () => {
    let resolveInitial!: (value: {
      items: Subscription[]
      total: number
      invalid_schedule_count: number
    }) => void
    let resolveOlder!: (value: {
      items: Subscription[]
      total: number
      invalid_schedule_count: number
    }) => void
    let resolveNewest!: (value: {
      items: Subscription[]
      total: number
      invalid_schedule_count: number
    }) => void
    const getSubscriptions = jest.mocked(subscriptionApis.getSubscriptions)
    getSubscriptions
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveInitial = resolve
          }) as never
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOlder = resolve
          }) as never
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveNewest = resolve
          }) as never
      )
    render(
      <SubscriptionProvider>
        <ExecutionCount />
      </SubscriptionProvider>
    )
    await waitFor(() => expect(getSubscriptions).toHaveBeenCalledTimes(1))
    await act(async () =>
      resolveInitial({ items: [SUBSCRIPTION], total: 1, invalid_schedule_count: 0 })
    )
    expect(mockExecutionUpdate).toBeDefined()
    act(() => mockExecutionUpdate?.(executionUpdate('COMPLETED')))
    act(() => mockExecutionUpdate?.(executionUpdate('FAILED')))
    await waitFor(() => expect(getSubscriptions).toHaveBeenCalledTimes(3))
    await act(async () =>
      resolveNewest({
        items: [{ ...SUBSCRIPTION, execution_count: 2 }],
        total: 1,
        invalid_schedule_count: 0,
      })
    )
    await act(async () =>
      resolveOlder({
        items: [{ ...SUBSCRIPTION, execution_count: 1 }],
        total: 1,
        invalid_schedule_count: 0,
      })
    )
    expect(await screen.findByText('2')).toBeInTheDocument()
  })
})
