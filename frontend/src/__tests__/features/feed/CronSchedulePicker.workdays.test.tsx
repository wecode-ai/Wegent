// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { CronSchedulePicker } from '@/features/feed/components/CronSchedulePicker'
import { RentSubscriptionDialog } from '@/features/feed/components/RentSubscriptionDialog'
import { SubscriptionOptionsSection } from '@/features/feed/components/subscription-form/SubscriptionOptionsSection'
import type { SubscriptionOptionsSectionProps } from '@/features/feed/components/subscription-form/types'
import { subscriptionApis } from '@/apis/subscription'
import type { MarketSubscriptionDetail } from '@/types/subscription'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => null,
  BranchSelector: () => null,
}))

jest.mock('@/components/ui/date-time-picker', () => ({ DateTimePicker: () => null }))
jest.mock('@/components/model-select/ModelCascadeSelect', () => ({
  GroupedModelSelect: () => null,
}))
jest.mock('@/apis/models', () => ({
  modelApis: { getUnifiedModels: jest.fn().mockResolvedValue({ data: [] }) },
}))
jest.mock('@/apis/subscription', () => ({
  subscriptionApis: { rentSubscription: jest.fn().mockResolvedValue({}) },
}))
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

describe('mainland China working day schedules', () => {
  beforeEach(() => jest.clearAllMocks())

  test('enables calendar filtering without changing the cron and restores ordinary previews when disabled', () => {
    const onChange = jest.fn()
    function Picker() {
      const [workdayOnly, setWorkdayOnly] = useState(false)
      return (
        <CronSchedulePicker
          value="0 9 * * *"
          onChange={onChange}
          timezone="Asia/Shanghai"
          workdayOnly={workdayOnly}
          onWorkdayOnlyChange={setWorkdayOnly}
        />
      )
    }
    render(<Picker />)

    expect(screen.getByText('execution_preview')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'workday_only' }))

    expect(screen.getByRole('checkbox', { name: 'workday_only' })).toBeChecked()
    expect(screen.queryByText('execution_preview')).not.toBeInTheDocument()
    expect(screen.getByText('workday_preview_hint')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'workday_only' }))
    expect(screen.getByText('execution_preview')).toBeInTheDocument()
    expect(screen.queryByText('workday_preview_hint')).not.toBeInTheDocument()
  })

  test('editing an existing workday subscription preserves the expression and timezone when changing the filter', () => {
    const setTriggerConfig = jest.fn()
    const props: SubscriptionOptionsSectionProps = {
      triggerType: 'cron',
      triggerConfig: {
        expression: '0 9 * * 1-5',
        timezone: 'America/New_York',
        workday_only: true,
      },
      setTriggerConfig,
      setTriggerType: jest.fn(),
      isCodeTypeTeam: false,
      selectedRepo: null,
      setSelectedRepo: jest.fn(),
      selectedBranch: null,
      setSelectedBranch: jest.fn(),
      retryCount: 0,
      setRetryCount: jest.fn(),
      timeoutSeconds: 600,
      setTimeoutSeconds: jest.fn(),
      expirationType: 'none',
      setExpirationType: jest.fn(),
      expirationDate: undefined,
      setExpirationDate: jest.fn(),
      durationDays: 30,
      setDurationDays: jest.fn(),
    }
    const { rerender } = render(<SubscriptionOptionsSection {...props} />)

    expect(screen.getByRole('checkbox', { name: 'workday_only' })).toBeChecked()
    expect(screen.queryByText('execution_preview')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'workday_only' }))
    expect(setTriggerConfig).toHaveBeenCalledWith({
      expression: '0 9 * * 1-5',
      timezone: 'America/New_York',
      workday_only: false,
    })

    rerender(
      <SubscriptionOptionsSection
        {...props}
        triggerConfig={{ expression: '0 9 * * *', timezone: 'Asia/Shanghai' }}
      />
    )
    expect(screen.getByRole('checkbox', { name: 'workday_only' })).not.toBeChecked()
    expect(screen.getByText('execution_preview')).toBeInTheDocument()
  })

  test('rental submission sends the working day filter and reopening resets it', async () => {
    const props = {
      open: true,
      onOpenChange: jest.fn(),
      subscription: {
        id: 7,
        name: 'daily-summary',
        display_name: 'Daily summary',
        trigger_type: 'cron',
      } as MarketSubscriptionDetail,
      onSuccess: jest.fn(),
    }
    const { rerender } = render(<RentSubscriptionDialog {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'workday_only' }))
    fireEvent.click(screen.getByTestId('rent-subscription-submit'))

    await waitFor(() =>
      expect(subscriptionApis.rentSubscription).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          trigger_type: 'cron',
          trigger_config: expect.objectContaining({
            expression: '0 9 * * *',
            workday_only: true,
          }),
        })
      )
    )
    expect(props.onSuccess).toHaveBeenCalled()

    rerender(<RentSubscriptionDialog {...props} open={false} />)
    await act(async () => {
      rerender(<RentSubscriptionDialog {...props} />)
    })
    expect(screen.getByRole('checkbox', { name: 'workday_only' })).not.toBeChecked()
  })
})
