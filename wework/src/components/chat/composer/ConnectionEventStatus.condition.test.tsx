import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ConnectionEventStatus } from './ConnectionEventStatus'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

const subscription = {
  subscription_key: 'document',
  source: { name: '发布文档' },
  status: 'armed',
  last_collected_at: Date.parse('2026-11-15T00:00:00Z'),
}

test('shows one subscription with both terminal outcomes and its commit scope', () => {
  render(
    <ConnectionEventStatus
      subscriptions={[
        {
          ...subscription,
          match: {
            '/external/payload/headRefOid': 'commit-123',
            $any: [
              { '/external/payload/statusCheckRollup/state': 'SUCCESS' },
              { '/external/payload/statusCheckRollup/state': 'FAILURE' },
            ],
          },
        },
      ]}
    />
  )
  expect(screen.getAllByTestId('connection-event-condition')).toHaveLength(1)
  expect(screen.getByTestId('connection-event-condition')).toHaveTextContent(
    '检查结果: 通过 或 检查结果: 失败'
  )
  expect(screen.getByTestId('connection-event-condition')).toHaveTextContent('提交: commit-123')
})
