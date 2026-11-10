// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SubscriptionTimeline } from '@/features/feed/components/SubscriptionTimeline'
import type { BackgroundExecution } from '@/types/subscription'

const mockGetExecution = jest.fn()

const mockContextValue = {
  executions: [] as BackgroundExecution[],
  executionsLoading: false,
  executionsRefreshing: false,
  executionsTotal: 0,
  loadMoreExecutions: jest.fn(),
  refreshExecutions: jest.fn(),
  cancelExecution: jest.fn(),
  deleteExecution: jest.fn(),
}

jest.mock('next/dynamic', () => () => {
  const MockDynamicComponent = () => <div data-testid="dynamic-content" />
  MockDynamicComponent.displayName = 'MockDynamicComponent'
  return MockDynamicComponent
})

jest.mock('@/features/feed/contexts/subscriptionContext', () => ({
  useSubscriptionContext: () => mockContextValue,
}))

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getExecution: (...args: unknown[]) => mockGetExecution(...args),
  },
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  EnhancedMarkdown: ({ source }: { source?: string }) => <div data-testid="md">{source}</div>,
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: jest.fn(), toggleTheme: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'feed.expand': 'Expand',
        'feed.collapse': 'Collapse',
        'feed.load_summary_failed': 'Failed to load the full summary',
      }

      return translations[key] ?? key
    },
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

const createExecution = (overrides: Partial<BackgroundExecution> = {}): BackgroundExecution => ({
  id: 1,
  user_id: 2,
  subscription_id: 10,
  trigger_type: 'schedule',
  prompt: 'Collect the daily news',
  status: 'COMPLETED',
  result_summary: 'summary body',
  retry_attempt: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  subscription_display_name: 'Daily news',
  task_type: 'collection',
  ...overrides,
})

describe('SubscriptionTimeline summary preview', () => {
  beforeEach(() => {
    mockContextValue.executions = []
    mockContextValue.executionsTotal = 0
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('loads the full summary once when a truncated summary is expanded', async () => {
    mockContextValue.executions = [createExecution({ id: 7, result_summary_truncated: true })]
    mockContextValue.executionsTotal = 1
    mockGetExecution.mockResolvedValue(
      createExecution({ id: 7, result_summary: 'full summary body' })
    )

    render(<SubscriptionTimeline />)

    // The collapsed card renders only the preview returned by the list endpoint.
    expect(screen.getByTestId('md')).toHaveTextContent(/^summary body$/)
    expect(mockGetExecution).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))

    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('full summary body'))
    expect(mockGetExecution).toHaveBeenCalledTimes(1)
    expect(mockGetExecution).toHaveBeenCalledWith(7)
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument()
  })

  test('expands a non-truncated summary without fetching it', () => {
    mockContextValue.executions = [createExecution({ id: 8, result_summary_truncated: false })]
    mockContextValue.executionsTotal = 1

    render(<SubscriptionTimeline />)

    expect(screen.getByTestId('md')).toHaveTextContent(/^summary body$/)

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))

    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument()
    expect(screen.getByTestId('md')).toHaveTextContent(/^summary body$/)
    expect(mockGetExecution).not.toHaveBeenCalled()
  })
})
