// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { SubscriptionPage } from '@/features/feed/components/SubscriptionPage'

jest.mock('next/dynamic', () => () => {
  const MockDynamicComponent = () => <div data-testid="dynamic-content" />
  MockDynamicComponent.displayName = 'MockDynamicComponent'
  return MockDynamicComponent
})

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
    t: (key: string) => {
      const translations: Record<string, string> = {
        automation_hint:
          'Create scheduled tasks, event-triggered tasks, or automation subscriptions for agents to run on plan.',
        'tabs.all': 'All',
        discover: 'Discover',
        'market.tab': 'Market',
        'tabs.mine': 'Mine',
        'feed.show_silent': 'Show silent executions',
        'feed.silent_executions': 'Silent executions',
      }

      return translations[key] ?? key
    },
  }),
}))

describe('SubscriptionPage automation hint', () => {
  test('explains that automation can create scheduled tasks', () => {
    render(<SubscriptionPage />)

    expect(
      screen.getByText(
        'Create scheduled tasks, event-triggered tasks, or automation subscriptions for agents to run on plan.'
      )
    ).toBeInTheDocument()
  })
})
