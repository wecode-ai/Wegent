// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'

import { SubscriptionOptionsSection } from '@/features/feed/components/subscription-form/SubscriptionOptionsSection'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        {
          subscription_options: '订阅选项',
          trigger_type: '触发类型',
          trigger_cron: 'Cron',
          trigger_interval: '间隔',
          trigger_one_time: '单次',
          trigger_event: '事件',
          trigger_config: '触发配置',
          event_type: '事件类型',
          retry_count: '失败重试次数',
          no_retry: '不重试',
          timeout_seconds: '执行超时时间',
          timeout_minutes: '分钟',
          unit_hours: '小时',
          custom_minute: '自定义',
          timeout_hint: 'AI 完成任务的最大时间限制，最高 24 小时',
        } as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/components/common/CollapsibleSection', () => ({
  CollapsibleSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => null,
  BranchSelector: () => null,
}))

jest.mock('@/features/feed/components/CronSchedulePicker', () => ({
  CronSchedulePicker: () => null,
}))

jest.mock('@/components/ui/date-time-picker', () => ({
  DateTimePicker: () => null,
}))

describe('SubscriptionOptionsSection timeout hint', () => {
  function renderSection(timeoutSeconds: number) {
    return render(
      <SubscriptionOptionsSection
        triggerType="event"
        setTriggerType={jest.fn()}
        triggerConfig={{ event_type: 'webhook' }}
        setTriggerConfig={jest.fn()}
        isCodeTypeTeam={false}
        selectedRepo={null}
        setSelectedRepo={jest.fn()}
        selectedBranch={null}
        setSelectedBranch={jest.fn()}
        retryCount={0}
        setRetryCount={jest.fn()}
        timeoutSeconds={timeoutSeconds}
        setTimeoutSeconds={jest.fn()}
        expirationType="none"
        setExpirationType={jest.fn()}
        expirationDate={undefined}
        setExpirationDate={jest.fn()}
        durationDays={30}
        setDurationDays={jest.fn()}
      />
    )
  }

  test('shows the 24 hour maximum beside the timeout control', () => {
    renderSection(24 * 60 * 60)

    expect(screen.getByText('AI 完成任务的最大时间限制，最高 24 小时')).toBeInTheDocument()
  })

  test('shows 24 hours as a preset option when selected', () => {
    renderSection(24 * 60 * 60)

    expect(screen.getByText('24 小时')).toBeInTheDocument()
    expect(screen.queryByText('timeout_option_24_hours')).not.toBeInTheDocument()
  })

  test('keeps historical non-preset values as custom minutes', () => {
    renderSection(2 * 60)

    expect(screen.getByText('自定义')).toBeInTheDocument()
    expect(screen.getByTestId('timeout-minutes-input')).toHaveValue(2)
  })

  test('switches back to preset display when loaded timeout becomes a preset value', () => {
    const { rerender } = renderSection(2 * 60)

    expect(screen.getByText('自定义')).toBeInTheDocument()

    rerender(
      <SubscriptionOptionsSection
        triggerType="event"
        setTriggerType={jest.fn()}
        triggerConfig={{ event_type: 'webhook' }}
        setTriggerConfig={jest.fn()}
        isCodeTypeTeam={false}
        selectedRepo={null}
        setSelectedRepo={jest.fn()}
        selectedBranch={null}
        setSelectedBranch={jest.fn()}
        retryCount={0}
        setRetryCount={jest.fn()}
        timeoutSeconds={60 * 60}
        setTimeoutSeconds={jest.fn()}
        expirationType="none"
        setExpirationType={jest.fn()}
        expirationDate={undefined}
        setExpirationDate={jest.fn()}
        durationDays={30}
        setDurationDays={jest.fn()}
      />
    )

    expect(screen.getByText('1 小时')).toBeInTheDocument()
    expect(screen.queryByTestId('timeout-minutes-input')).not.toBeInTheDocument()
  })
})
