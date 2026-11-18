import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
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

describe('ConnectionEventStatus', () => {
  test('does not promise healthy monitoring before the first collection succeeds', () => {
    render(
      <ConnectionEventStatus subscriptions={[{ ...subscription, last_collected_at: undefined }]} />
    )
    expect(screen.getByRole('status')).toHaveTextContent('正在同步状态')
    expect(screen.queryByText('等待事件，到达后自动继续')).not.toBeInTheDocument()
  })

  test('shows the selected source and automatic continuation without requiring configuration', () => {
    const { rerender } = render(<ConnectionEventStatus subscriptions={[subscription]} />)
    expect(screen.getByRole('status')).toHaveTextContent('等待事件，到达后自动继续')
    expect(screen.getByRole('status')).toHaveTextContent('发布文档')
    rerender(<ConnectionEventStatus subscriptions={[{ ...subscription, status: 'pending' }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('等待会话继续执行')
  })

  test('reports collection failure instead of promising healthy monitoring', () => {
    render(
      <ConnectionEventStatus
        subscriptions={[{ ...subscription, error_code: 'connector_auth_required' }]}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('连接需要重新授权')
    expect(screen.queryByText('等待事件，到达后自动继续')).not.toBeInTheDocument()
  })

  test.each(['pending', 'resuming_goal'])(
    'shows human participation before continuation for %s',
    status => {
      const { rerender } = render(
        <ConnectionEventStatus
          subscriptions={[{ ...subscription, status }]}
          interactionStatus="awaitingUserReply"
        />
      )
      expect(screen.getByRole('status')).toHaveTextContent('等待你处理当前问题或确认')
      expect(screen.queryByText('已收到事件，正在恢复目标')).not.toBeInTheDocument()
      rerender(<ConnectionEventStatus subscriptions={[{ ...subscription, status }]} />)
      expect(screen.getByRole('status')).toHaveTextContent('等待会话继续执行')
    }
  )

  test('received events keep execution status when subsequent collection is unavailable', () => {
    render(
      <ConnectionEventStatus
        subscriptions={[
          { ...subscription, status: 'resuming_goal', error_code: 'connector_auth_required' },
        ]}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('等待会话继续执行')
    expect(screen.queryByText('连接需要重新授权')).not.toBeInTheDocument()
  })

  test.each(['error', 'needs_attention'])(
    'does not mislabel an execution failure as a connection failure for %s',
    status => {
      render(
        <ConnectionEventStatus
          subscriptions={[{ ...subscription, status, error_code: 'event_admission_failed' }]}
        />
      )
      expect(screen.getByRole('status')).toHaveTextContent('事件继续执行遇到问题，请查看会话')
      expect(screen.queryByText('状态同步异常，请检查连接')).not.toBeInTheDocument()
    }
  )

  test('distinguishes preparing the wait from synchronizing source state', () => {
    render(<ConnectionEventStatus subscriptions={[{ ...subscription, status: 'preparing' }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在设置事件等待')
  })

  test.each([
    ['event_subscription_unavailable', '事件等待尚未设置成功，请让 AI 检查并重试'],
    ['connector_auth_required', '连接需要重新授权'],
  ])('does not hide preparation failure %s behind a progress label', (error_code, expected) => {
    render(
      <ConnectionEventStatus
        subscriptions={[{ ...subscription, status: 'preparing', error_code }]}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(expected)
    expect(screen.queryByText('正在设置事件等待')).not.toBeInTheDocument()
  })

  test('hides cancelled and delivered subscriptions and ignores malformed runtime metadata', () => {
    render(
      <ConnectionEventStatus
        subscriptions={[
          null,
          {},
          { ...subscription, status: 'cancelled' },
          { ...subscription, status: 'delivered' },
        ]}
      />
    )
    expect(screen.queryByTestId('connection-event-status')).not.toBeInTheDocument()
  })

  test('reports unavailable selected resources even when the source collector is connected', () => {
    render(
      <ConnectionEventStatus
        subscriptions={[
          {
            ...subscription,
            resource_states: [
              {
                kind: 'change_request',
                provider: 'github',
                topicId: 'pr',
                observedAt: '2026-11-15T00:00:00Z',
                data: {},
                errorCode: 'git_permission_denied',
              },
            ],
          },
        ]}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('状态同步异常，请检查连接')
    expect(screen.queryByText('等待事件，到达后自动继续')).not.toBeInTheDocument()
  })
})

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
