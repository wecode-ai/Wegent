// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import QuotaUsage from '@/features/tasks/components/params/QuotaUsage'

const fetchQuota = jest.fn()
const getRuntimeConfigSync = jest.fn()
const useChatStatusIndicator = jest.fn()

jest.mock('@/apis/quota', () => ({
  quotaApis: {
    fetchQuota: () => fetchQuota(),
  },
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => getRuntimeConfigSync(),
}))

jest.mock('@/features/tasks/hooks/useChatStatusIndicator', () => ({
  useChatStatusIndicator: () => useChatStatusIndicator(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'common:chat_status.title') return 'Chat Status'
      if (key === 'common:chat_status.context_remaining') {
        return `Context ${params?.percent}% left`
      }
      if (key === 'common:chat_status.context_usage') {
        return `${params?.used} / ${params?.total} context tokens`
      }
      if (key === 'common:chat_status.over_trigger') return 'Compression threshold reached'
      if (key === 'common:quota.title') return 'Model quota'
      if (key === 'common:quota.brief') return 'Quota brief'
      if (key === 'common:quota.detail_monthly') return 'Monthly quota detail'
      if (key === 'common:quota.detail_permanent') return 'Permanent quota detail'
      if (key === 'common:quota.load_failed') return 'Failed to fetch quota info'
      return key
    },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

describe('QuotaUsage', () => {
  beforeEach(() => {
    fetchQuota.mockReset()
    getRuntimeConfigSync.mockReset()
    useChatStatusIndicator.mockReset()
  })

  test('renders context status without quota data', async () => {
    getRuntimeConfigSync.mockReturnValue({
      enableDisplayQuotas: false,
    })
    fetchQuota.mockResolvedValue(null)
    useChatStatusIndicator.mockReturnValue({
      enabled: true,
      shouldRender: true,
      currentTaskId: 1,
      display: {
        percent: 57,
        usedTokens: '113,167',
        totalTokens: '262,144',
        isOverTrigger: false,
      },
    })

    render(<QuotaUsage compact />)

    fireEvent.click(await screen.findByTestId('chat-meta-trigger'))

    expect(await screen.findByTestId('chat-status-section')).toHaveTextContent('Context 57% left')
    expect(screen.queryByTestId('quota-usage-section')).not.toBeInTheDocument()
  })

  test('renders quota section when quota data is available', async () => {
    getRuntimeConfigSync.mockReturnValue({
      enableDisplayQuotas: true,
    })
    fetchQuota.mockResolvedValue({
      quota_source: 'Claude',
      quota: 0,
      remaining: 0,
      usage: 0,
      user: 'tester',
      user_quota_detail: {
        demand_quota: 0,
        monthly_quota: 100,
        monthly_usage: 20,
        permanent_quota: 10,
        permanent_usage: 1,
        task_quota: 0,
      },
    })
    useChatStatusIndicator.mockReturnValue({
      enabled: false,
      shouldRender: false,
      currentTaskId: null,
      display: null,
    })

    render(<QuotaUsage compact />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-meta-trigger')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('chat-meta-trigger'))

    expect(await screen.findByTestId('quota-usage-section')).toHaveTextContent('Quota brief')
    expect(screen.queryByTestId('chat-status-section')).not.toBeInTheDocument()
  })
})
