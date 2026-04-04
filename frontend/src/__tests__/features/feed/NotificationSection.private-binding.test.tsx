// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import { NotificationSection } from '@/features/feed/components/subscription-form/NotificationSection'
import type {
  NotificationChannelBindingConfig,
  NotificationChannelInfo,
  NotificationLevel,
  NotificationWebhook,
} from '@/types/subscription'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('@/lib/runtime-config', () => ({
  DEFAULT_BIND_GROUP_STEPS: JSON.stringify({
    variables: {},
    steps: [{ title: 'Add bot' }, { title: 'Start binding' }, { title: '@ bot in group' }],
  }),
  fetchRuntimeConfig: jest.fn().mockResolvedValue({}),
}))

interface HarnessProps {
  availableChannels: NotificationChannelInfo[]
  onStartBinding: (channelId: number, bindPrivate: boolean, bindGroup: boolean) => Promise<void>
  onCancelBinding: (channelId: number) => Promise<void>
}

function NotificationSectionHarness({
  availableChannels,
  onStartBinding,
  onCancelBinding,
}: HarnessProps) {
  const [devNotificationLevel, setDevNotificationLevel] = useState<NotificationLevel>('notify')
  const [devNotificationChannels, setDevNotificationChannels] = useState<number[]>([410])
  const [notificationWebhooks, setNotificationWebhooks] = useState<NotificationWebhook[]>([])
  const [channelBindingConfigs, setChannelBindingConfigs] = useState<
    NotificationChannelBindingConfig[]
  >([
    {
      channel_id: 410,
      bind_private: false,
      bind_group: false,
    },
  ])

  return (
    <NotificationSection
      devNotificationLevel={devNotificationLevel}
      setDevNotificationLevel={setDevNotificationLevel}
      devNotificationChannels={devNotificationChannels}
      setDevNotificationChannels={setDevNotificationChannels}
      devAvailableChannels={availableChannels}
      devSettingsLoading={false}
      notificationWebhooks={notificationWebhooks}
      setNotificationWebhooks={setNotificationWebhooks}
      channelBindingConfigs={channelBindingConfigs}
      setChannelBindingConfigs={setChannelBindingConfigs}
      onStartBinding={onStartBinding}
      onCancelBinding={onCancelBinding}
      bindingWaitingState={{}}
    />
  )
}

describe('NotificationSection private binding dialog', () => {
  test('shows level helper text and switches it when notification level changes', async () => {
    const user = userEvent.setup()

    render(
      <NotificationSectionHarness
        availableChannels={[
          {
            id: 410,
            name: '钉钉',
            channel_type: 'dingtalk',
            is_bound: true,
          },
        ]}
        onStartBinding={jest.fn().mockResolvedValue(undefined)}
        onCancelBinding={jest.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByText('通过 Messager 渠道发送通知')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: '默认' }))

    expect(screen.getByText('在动态时间线中显示')).toBeInTheDocument()
  })

  test('renders dingtalk channel configuration as a visible panel instead of hidden options', () => {
    render(
      <NotificationSectionHarness
        availableChannels={[
          {
            id: 410,
            name: '钉钉',
            channel_type: 'dingtalk',
            is_bound: true,
          },
        ]}
        onStartBinding={jest.fn().mockResolvedValue(undefined)}
        onCancelBinding={jest.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByText('钉钉通知配置')).toBeInTheDocument()
    expect(screen.queryByText('隐藏选项')).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '未启用私聊' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '未启用群聊' })).toBeInTheDocument()
    expect(screen.getByText('已绑定至：当前私聊会话')).toBeInTheDocument()
  })

  test('updates delivery titles dynamically and keeps title stronger than binding status', async () => {
    const user = userEvent.setup()

    render(
      <NotificationSectionHarness
        availableChannels={[
          {
            id: 410,
            name: '钉钉',
            channel_type: 'dingtalk',
            is_bound: true,
          },
        ]}
        onStartBinding={jest.fn().mockResolvedValue(undefined)}
        onCancelBinding={jest.fn().mockResolvedValue(undefined)}
      />
    )

    const privateTitle = screen.getByTestId('private-delivery-title-410')
    const privateStatus = screen.getByTestId('private-delivery-status-410')

    expect(privateTitle).toHaveTextContent('未启用私聊')
    expect(privateTitle.className).toContain('text-base')
    expect(privateStatus.className).toContain('text-sm')

    await user.click(screen.getByRole('switch', { name: '未启用私聊' }))

    expect(screen.getByTestId('private-delivery-title-410')).toHaveTextContent('已启用私聊')
  })

  test('shows real-time private binding success after the channel becomes bound', async () => {
    const user = userEvent.setup()
    const onStartBinding = jest.fn().mockResolvedValue(undefined)
    const onCancelBinding = jest.fn().mockResolvedValue(undefined)
    const initialChannels: NotificationChannelInfo[] = [
      {
        id: 410,
        name: '钉钉',
        channel_type: 'dingtalk',
        is_bound: false,
      },
    ]

    const { rerender } = render(
      <NotificationSectionHarness
        availableChannels={initialChannels}
        onStartBinding={onStartBinding}
        onCancelBinding={onCancelBinding}
      />
    )

    await user.click(screen.getByRole('switch', { name: '未启用私聊' }))
    await user.click(screen.getByTestId('private-binding-start-button'))

    await waitFor(() => {
      expect(onStartBinding).toHaveBeenCalledWith(410, true, false)
    })
    expect(screen.getByText('正在等待绑定...')).toBeInTheDocument()

    rerender(
      <NotificationSectionHarness
        availableChannels={[
          {
            ...initialChannels[0],
            is_bound: true,
          },
        ]}
        onStartBinding={onStartBinding}
        onCancelBinding={onCancelBinding}
      />
    )

    expect(await screen.findByText('绑定成功')).toBeInTheDocument()
  })

  test('reuses existing group binding without opening the group binding dialog', async () => {
    const user = userEvent.setup()
    const onStartBinding = jest.fn().mockResolvedValue(undefined)
    const onCancelBinding = jest.fn().mockResolvedValue(undefined)

    function GroupBindingHarness() {
      const [devNotificationLevel, setDevNotificationLevel] = useState<NotificationLevel>('notify')
      const [devNotificationChannels, setDevNotificationChannels] = useState<number[]>([410])
      const [notificationWebhooks, setNotificationWebhooks] = useState<NotificationWebhook[]>([])
      const [channelBindingConfigs, setChannelBindingConfigs] = useState<
        NotificationChannelBindingConfig[]
      >([
        {
          channel_id: 410,
          bind_private: true,
          bind_group: false,
          group_conversation_id: 'group-123',
          group_name: '测试机器人',
        },
      ])

      return (
        <NotificationSection
          devNotificationLevel={devNotificationLevel}
          setDevNotificationLevel={setDevNotificationLevel}
          devNotificationChannels={devNotificationChannels}
          setDevNotificationChannels={setDevNotificationChannels}
          devAvailableChannels={[
            {
              id: 410,
              name: '钉钉',
              channel_type: 'dingtalk',
              is_bound: true,
            },
          ]}
          devSettingsLoading={false}
          notificationWebhooks={notificationWebhooks}
          setNotificationWebhooks={setNotificationWebhooks}
          channelBindingConfigs={channelBindingConfigs}
          setChannelBindingConfigs={setChannelBindingConfigs}
          onStartBinding={onStartBinding}
          onCancelBinding={onCancelBinding}
          bindingWaitingState={{}}
        />
      )
    }

    render(<GroupBindingHarness />)

    await user.click(screen.getByRole('switch', { name: '未启用群聊' }))

    expect(screen.queryByTestId('group-binding-start-button')).not.toBeInTheDocument()
    expect(screen.getByText('已绑定至：测试机器人')).toBeInTheDocument()
    expect(screen.getByTestId('group-delivery-title-410')).toHaveTextContent('已启用群聊')
  })

  test('shows existing group binding even when group sending is disabled', () => {
    function DisabledGroupBindingHarness() {
      const [devNotificationLevel, setDevNotificationLevel] = useState<NotificationLevel>('notify')
      const [devNotificationChannels, setDevNotificationChannels] = useState<number[]>([410])
      const [notificationWebhooks, setNotificationWebhooks] = useState<NotificationWebhook[]>([])
      const [channelBindingConfigs, setChannelBindingConfigs] = useState<
        NotificationChannelBindingConfig[]
      >([
        {
          channel_id: 410,
          bind_private: true,
          bind_group: false,
          group_conversation_id: 'group-123',
          group_name: '测试机器人',
        },
      ])

      return (
        <NotificationSection
          devNotificationLevel={devNotificationLevel}
          setDevNotificationLevel={setDevNotificationLevel}
          devNotificationChannels={devNotificationChannels}
          setDevNotificationChannels={setDevNotificationChannels}
          devAvailableChannels={[
            {
              id: 410,
              name: '钉钉',
              channel_type: 'dingtalk',
              is_bound: true,
            },
          ]}
          devSettingsLoading={false}
          notificationWebhooks={notificationWebhooks}
          setNotificationWebhooks={setNotificationWebhooks}
          channelBindingConfigs={channelBindingConfigs}
          setChannelBindingConfigs={setChannelBindingConfigs}
          onStartBinding={jest.fn().mockResolvedValue(undefined)}
          onCancelBinding={jest.fn().mockResolvedValue(undefined)}
          bindingWaitingState={{}}
        />
      )
    }

    render(<DisabledGroupBindingHarness />)

    expect(screen.getByText('已绑定至：测试机器人')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '未启用群聊' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByTestId('group-delivery-title-410')).toHaveTextContent('未启用群聊')
  })
})
