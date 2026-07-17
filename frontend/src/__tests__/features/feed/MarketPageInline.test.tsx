// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { MarketPageInline } from '@/features/feed/components/MarketPageInline'
import type { MarketSubscriptionsListResponse } from '@/types/subscription'

const mockDiscoverMarketSubscriptions = jest.fn()
const mockToast = jest.fn()
const mockT = (key: string) => key

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    discoverMarketSubscriptions: (...args: unknown[]) => mockDiscoverMarketSubscriptions(...args),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 1 } }),
}))

jest.mock('@/features/feed/components/RentSubscriptionDialog', () => ({
  RentSubscriptionDialog: () => null,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('MarketPageInline', () => {
  test('ignores a stale response after a newer search completes', async () => {
    jest.useFakeTimers()
    const initialRequest = deferred<MarketSubscriptionsListResponse>()
    const searchRequest = deferred<MarketSubscriptionsListResponse>()
    mockDiscoverMarketSubscriptions
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(searchRequest.promise)

    render(<MarketPageInline />)
    const searchInput = screen.getByPlaceholderText('discover_search_placeholder')
    fireEvent.compositionStart(searchInput)
    fireEvent.change(searchInput, {
      target: { value: '大' },
    })

    act(() => {
      jest.advanceTimersByTime(300)
    })
    expect(mockDiscoverMarketSubscriptions).toHaveBeenCalledTimes(1)

    fireEvent.compositionEnd(searchInput)
    act(() => {
      jest.advanceTimersByTime(300)
    })

    expect(mockDiscoverMarketSubscriptions).toHaveBeenCalledTimes(2)

    await act(async () => {
      searchRequest.resolve({
        total: 1,
        items: [
          {
            id: 2,
            name: 'search-result',
            display_name: '大模型日报',
            task_type: 'execution',
            trigger_type: 'cron',
            trigger_description: '每天',
            owner_user_id: 2,
            owner_username: 'owner',
            rental_count: 3,
            is_rented: false,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      })
    })
    expect(screen.getByText('大模型日报')).toBeInTheDocument()

    await act(async () => {
      initialRequest.resolve({ total: 0, items: [] })
    })

    expect(screen.getByText('大模型日报')).toBeInTheDocument()
    jest.useRealTimers()
  })
})
