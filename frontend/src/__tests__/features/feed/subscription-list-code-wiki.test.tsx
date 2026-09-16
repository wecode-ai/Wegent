// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { subscriptionApis } from '@/apis/subscription'
import { SubscriptionList } from '@/features/feed/components/SubscriptionList'
import { useSubscriptionContext } from '@/features/feed/contexts/subscriptionContext'
import type { Subscription } from '@/types/subscription'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'code_wiki_scheduled_update_hint' ? 'Manage in Wiki' : key),
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/feed/contexts/subscriptionContext', () => ({
  useSubscriptionContext: jest.fn(),
}))

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: { getExecutions: jest.fn() },
}))

const CODE_WIKI_SUBSCRIPTION: Subscription = {
  id: 12,
  code_wiki_id: 34,
  user_id: 1,
  name: 'code-wiki-34',
  namespace: 'default',
  display_name: 'Wegent Wiki',
  task_type: 'execution',
  visibility: 'private',
  trigger_type: 'interval',
  trigger_config: { value: 1, unit: 'days' },
  team_id: 0,
  prompt_template: '',
  retry_count: 0,
  timeout_seconds: 21600,
  enabled: true,
  last_execution_time: '2026-09-15T11:00:00',
  last_execution_status: 'COMPLETED',
  last_execution_message: 'incremental generation started',
  next_execution_time: '2026-09-16T11:00:00',
  execution_count: 5,
  success_count: 5,
  failure_count: 0,
  followers_count: 0,
  is_following: false,
  created_at: '2026-09-01T00:00:00',
  updated_at: '2026-09-01T00:00:00',
}

describe('Code Wiki subscription row', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(useSubscriptionContext).mockReturnValue({
      subscriptions: [CODE_WIKI_SUBSCRIPTION],
      subscriptionsLoading: false,
      subscriptionsTotal: 1,
      refreshSubscriptions: jest.fn(),
      loadMoreSubscriptions: jest.fn(),
      refreshExecutions: jest.fn(),
      invalidScheduleCount: 0,
    } as unknown as ReturnType<typeof useSubscriptionContext>)
    jest.mocked(subscriptionApis.getExecutions).mockResolvedValue({
      total: 1,
      items: [
        {
          id: 91,
          subscription_id: 12,
          status: 'COMPLETED_SILENT',
          result_summary: 'The wiki is published and the repository is unchanged.',
          created_at: '2026-09-15T11:00:00',
          task_id: 56,
        },
      ],
    } as never)
  })

  it('keeps navigation and history as separate explicit actions', async () => {
    render(<SubscriptionList onCreateSubscription={jest.fn()} onEditSubscription={jest.fn()} />)

    const row = screen.getByTestId('code-wiki-subscription-row')
    expect(row).not.toHaveAttribute('href')
    expect(row).toHaveClass('sm:pr-2')
    expect(screen.getByTestId('code-wiki-subscription-controls')).toHaveClass('gap-3')
    const links = within(row).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/knowledge?type=document&kb=34')
    expect(links[0]).toHaveTextContent('Manage in Wiki')
    expect(links[0]).toHaveClass('sm:w-32')
    expect(screen.getByTestId('code-wiki-subscription-meta')).toHaveTextContent('status_completed')
    const executionCount = screen.getByTestId('code-wiki-subscription-execution-count')
    expect(executionCount).toHaveTextContent('5executions')
    expect(executionCount).toHaveClass('min-h-11', 'md:min-h-0')
    expect(links[0]).toHaveClass('h-11', 'w-11', 'md:h-8')
    expect(screen.getByTestId('code-wiki-subscription-enabled-indicator')).toHaveAttribute(
      'aria-label',
      'enabled'
    )
    expect(executionCount).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('code-wiki-subscription-last-execution')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('trigger_now')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('edit')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('delete')).not.toBeInTheDocument()
    expect(
      screen.queryByText('The wiki is published and the repository is unchanged.')
    ).not.toBeInTheDocument()

    fireEvent.click(executionCount)

    await waitFor(() =>
      expect(subscriptionApis.getExecutions).toHaveBeenCalledWith(
        { page: 1, limit: 5 },
        12,
        undefined,
        undefined,
        undefined,
        true
      )
    )
    expect(
      await screen.findByText('The wiki is published and the repository is unchanged.')
    ).toBeInTheDocument()
    expect(executionCount).toHaveAttribute('aria-expanded', 'true')
  })

  it('refreshes expanded history on terminal changes and re-fetches on reopen', async () => {
    const props = { onCreateSubscription: jest.fn(), onEditSubscription: jest.fn() }
    const { rerender } = render(<SubscriptionList {...props} />)
    const count = screen.getByTestId('code-wiki-subscription-execution-count')
    fireEvent.click(count)
    await screen.findByText('The wiki is published and the repository is unchanged.')
    jest.mocked(subscriptionApis.getExecutions).mockResolvedValue({
      total: 1,
      items: [
        {
          id: 92,
          subscription_id: 12,
          status: 'COMPLETED_SILENT',
          result_summary: 'repository unchanged since last run',
          created_at: '2026-09-16T11:00:00',
        },
      ],
    } as never)
    const context = jest.mocked(useSubscriptionContext).mock.results[0].value
    jest.mocked(useSubscriptionContext).mockReturnValue({
      ...context,
      subscriptions: [
        {
          ...CODE_WIKI_SUBSCRIPTION,
          last_execution_status: 'COMPLETED_SILENT',
        },
      ],
    })
    rerender(<SubscriptionList {...props} />)
    await screen.findByText('knowledge:codeWiki.scheduledUpdate.results.repositoryUnchanged')
    expect(subscriptionApis.getExecutions).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByText('The wiki is published and the repository is unchanged.')
    ).not.toBeInTheDocument()
    fireEvent.click(count)
    fireEvent.click(count)
    await waitFor(() => expect(subscriptionApis.getExecutions).toHaveBeenCalledTimes(3))
  })

  it('does not let an old request replace newer execution history', async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof subscriptionApis.getExecutions>>) => void
    jest.mocked(subscriptionApis.getExecutions).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve
        })
    )
    const props = { onCreateSubscription: jest.fn(), onEditSubscription: jest.fn() }
    const { rerender } = render(<SubscriptionList {...props} />)
    fireEvent.click(screen.getByTestId('code-wiki-subscription-execution-count'))
    const context = jest.mocked(useSubscriptionContext).mock.results[0].value
    jest.mocked(useSubscriptionContext).mockReturnValue({
      ...context,
      subscriptions: [
        {
          ...CODE_WIKI_SUBSCRIPTION,
          execution_count: 6,
          last_execution_time: '2026-09-16T11:00:00',
        },
      ],
    })
    rerender(<SubscriptionList {...props} />)
    await screen.findByText('The wiki is published and the repository is unchanged.')
    await act(async () => finishOld({ total: 0, items: [] } as never))
    expect(
      screen.getByText('The wiki is published and the repository is unchanged.')
    ).toBeInTheDocument()
    expect(subscriptionApis.getExecutions).toHaveBeenCalledTimes(2)
  })
})
