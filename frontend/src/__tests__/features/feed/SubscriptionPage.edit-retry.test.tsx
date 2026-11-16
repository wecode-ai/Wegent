// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SubscriptionPage } from '@/features/feed/components/SubscriptionPage'
import { loadEditableSubscription } from '@/features/feed/components/subscription-form/load-editable-subscription'
import type { Subscription } from '@/types/subscription'

jest.mock('@/features/feed/components/subscription-form/load-editable-subscription', () => ({
  loadEditableSubscription: jest.fn(),
}))

jest.mock('@/features/feed/contexts/subscriptionContext', () => ({
  SubscriptionProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useSubscriptionContext: () => ({
    refreshSubscriptions: jest.fn(),
    refreshExecutions: jest.fn(),
    showSilentExecutions: false,
    setShowSilentExecutions: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('next/dynamic', () => {
  return (loader: () => Promise<Record<string, React.ComponentType<Record<string, unknown>>>>) => {
    const Dynamic = (props: Record<string, unknown>) => {
      if (props.subscription) return <div data-testid="edit-form" />
      if (props.onEditSubscription) {
        return (
          <button
            data-testid="edit-subscription"
            onClick={() =>
              (props.onEditSubscription as (subscription: Subscription) => void)(listItem)
            }
          >
            Edit
          </button>
        )
      }
      return <div data-testid="dynamic-content" />
    }
    Dynamic.displayName = 'Dynamic'
    Dynamic.preload = loader
    return Dynamic
  }
})

const mockedLoad = loadEditableSubscription as jest.MockedFunction<typeof loadEditableSubscription>
const listItem = { id: 42, prompt_template: 'stale prompt' } as Subscription

describe('SubscriptionPage edit loading', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('blocks editing after a failed detail request and opens only after retry succeeds', async () => {
    const user = userEvent.setup()
    mockedLoad.mockRejectedValueOnce(new Error('network down'))
    render(<SubscriptionPage />)

    await user.click(screen.getByText('tabs.mine'))
    await user.click(screen.getByTestId('edit-subscription'))
    await waitFor(() => expect(mockedLoad).toHaveBeenCalledWith(listItem))
    expect(await screen.findByTestId('subscription-edit-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-form')).not.toBeInTheDocument()

    const latest = { id: 42, prompt_template: 'latest prompt' } as Subscription
    mockedLoad.mockResolvedValueOnce(latest)
    await user.click(screen.getByTestId('subscription-edit-retry'))

    expect(await screen.findByTestId('edit-form')).toBeInTheDocument()
    expect(screen.queryByTestId('subscription-edit-load-error')).not.toBeInTheDocument()
    expect(mockedLoad).toHaveBeenCalledTimes(2)
  })
})
