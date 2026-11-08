import type { ComponentProps } from 'react'
import type { Automation } from '@/types/automation'
import type { AutomationApi } from '@/features/workbench/workbenchServices'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import { StandInDetailsPopover } from './StandInDetailsPopover'

const address = { deviceId: 'local', taskId: 'stand-in-chat-7-primary' }

afterEach(() => {
  document.querySelector('[data-fixture-anchor]')?.remove()
})

function fixture(overrides: Partial<ComponentProps<typeof StandInDetailsPopover>> = {}) {
  const anchor = document.createElement('button')
  anchor.dataset.fixtureAnchor = 'true'
  document.body.append(anchor)
  const props = {
    anchor,
    userId: 7,
    name: '我的分身',
    enabled: true,
    conversation: address,
    device: {
      id: 1,
      device_id: 'local',
      name: '工作电脑',
      status: 'online' as const,
      device_type: 'local' as const,
      is_default: true,
      bind_shell: 'claudecode' as const,
    },
    items: [],
    inbox: [],
    sourceErrors: [],
    onClose: vi.fn(),
    onSettings: vi.fn(),
    renderActivity: (item: typeof runtimeItem) => (
      <div>{`Conversation: ${item.address.taskId}`}</div>
    ),
    onStatus: vi.fn(),
    onOpenTask: vi.fn(),
    ...overrides,
  }
  render(<StandInDetailsPopover {...props} />)
  return props
}

it('shows device, empty activity and outputs without exposing configuration controls', async () => {
  const props = fixture()
  expect(await screen.findByRole('dialog', { name: '分身详情' })).toBeVisible()
  expect(screen.getByText('工作电脑')).toBeVisible()
  expect(screen.getByText('在线')).toBeVisible()
  expect(screen.getByText('最近暂无活动')).toBeVisible()
  expect(screen.queryByText('输出内容')).not.toBeInTheDocument()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByText('停止分身')).not.toBeInTheDocument()
  expect(props.onOpenTask).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-details-identity').querySelector('svg')).toBeNull()
  await userEvent.setup().click(screen.getByTestId('stand-in-settings-open'))
  expect(props.onSettings).toHaveBeenCalledOnce()
})

it('opens activity inside the same popover and restores focus on back', async () => {
  const props = fixture({ items: [runtimeItem] })
  const user = userEvent.setup()
  expect(await screen.findByText(/Project · 处理中/)).toBeVisible()
  const row = screen.getByTestId('stand-in-details-task-task')
  await user.click(row)
  expect(screen.getByText('Conversation: task')).toBeVisible()
  expect(props.onClose).not.toHaveBeenCalled()
  expect(props.onOpenTask).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-details-back'))
  expect(row).toBeVisible()
  await vi.waitFor(() => expect(row).toHaveFocus())
  await user.click(row)
  await user.click(screen.getByTestId('stand-in-details-open-task'))
  expect(props.onOpenTask).toHaveBeenCalledWith(runtimeItem.address)
})

it('shows four activities at a time and retains expansion after returning from detail', async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({
    ...runtimeItem,
    key: String(i),
    task: { ...runtimeItem.task, taskId: `task-${i}` },
    address: { ...runtimeItem.address, taskId: `task-${i}` },
  }))
  fixture({ items })
  const user = userEvent.setup()
  await screen.findByTestId('stand-in-details-popover')
  expect(screen.queryByTestId('stand-in-details-task-task-4')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-details-more'))
  expect(screen.getByTestId('stand-in-details-task-task-7')).toBeVisible()
  expect(screen.queryByTestId('stand-in-details-task-task-8')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-details-task-task-7'))
  await user.click(screen.getByTestId('stand-in-details-back'))
  expect(screen.getByTestId('stand-in-details-task-task-7')).toBeVisible()
})

it('mixes owned schedules and work by recency and opens the original schedule detail', async () => {
  const schedule = {
    id: 'weekly',
    name: '每周回顾',
    enabled: true,
    updatedAt: '2026-11-08T12:00:00Z',
    timezone: 'Asia/Shanghai',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    taskRequest: {
      deviceId: 'local',
      standInOwner: { userId: 7, roleId: '@primary' },
      standInCalendar: {},
    },
  } as Automation
  const props = fixture({
    items: [runtimeItem],
    onSchedule: vi.fn(),
    automationApi: {
      listAutomations: vi.fn().mockResolvedValue({ items: [schedule] }),
    } as unknown as AutomationApi,
  })
  const button = await screen.findByTestId('stand-in-details-schedule-weekly')
  const work = screen.getByTestId('stand-in-details-task-task')
  expect(button.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText('每天 09:00')).toBeVisible()
  expect(screen.getByTestId('stand-in-details-popover')).toHaveStyle({ width: '300px' })
  await userEvent.setup().click(button)
  expect(props.onSchedule).toHaveBeenCalledWith(schedule, button)
  expect(props.onOpenTask).not.toHaveBeenCalled()
})

it('retains the expanded identity height while the scrolled header becomes compact', async () => {
  fixture()
  const identity = await screen.findByTestId('stand-in-details-identity')
  Object.defineProperty(identity, 'offsetHeight', { configurable: true, value: 88 })
  const scroll = identity.parentElement!.parentElement!.parentElement!
  fireEvent.scroll(scroll, { target: { scrollTop: 20 } })
  expect(identity).toHaveClass('h-12')
  expect(identity.parentElement).toHaveStyle({ height: '88px' })
  fireEvent.scroll(scroll, { target: { scrollTop: 0 } })
  expect(identity).not.toHaveClass('h-12')
})

it('summarizes source problems without filling the profile with error paragraphs', async () => {
  const props = fixture({
    device: {
      id: 1,
      device_id: 'remote',
      name: '远程电脑',
      status: 'offline',
      device_type: 'remote',
      is_default: false,
      bind_shell: 'claudecode',
    },
    sourceErrors: [
      {
        source: {
          providerId: 'example',
          profile: 'work',
          id: 'group',
          name: '研发群',
          kind: 'group',
          policy: { automatic: true, askBeforeAct: true },
        },
        error: { code: 'dependency_missing', message: 'Dependency is missing' },
      },
    ],
  })
  expect(await screen.findByText('离线')).toBeVisible()
  expect(screen.getByText('连接或运行需要处理')).toBeVisible()
  expect(screen.queryByText('研发群')).not.toBeInTheDocument()
  expect(screen.queryByText(/来源所需插件尚未安装/)).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('stand-in-status-open'))
  expect(props.onStatus).toHaveBeenCalledOnce()
  expect(screen.queryByText(/需要检查/)).not.toBeInTheDocument()
})

it.each(['escape', 'outside'] as const)(
  'closes through the shared popover %s interaction',
  async kind => {
    const props = fixture()
    await screen.findByTestId('stand-in-details-popover')
    if (kind === 'escape') await userEvent.setup().keyboard('{Escape}')
    else fireEvent.pointerDown(document.body)
    expect(props.onClose).toHaveBeenCalledOnce()
  }
)

it('does not expose enabled activity controls without an actual navigation handler', async () => {
  fixture({ items: [runtimeItem], renderActivity: undefined, onOpenTask: undefined })
  expect(await screen.findByTestId('stand-in-details-task-task')).toBeDisabled()
})

it('does not turn subagent children or execution blocks into separate activities', async () => {
  fixture({
    items: [
      {
        ...runtimeItem,
        task: {
          ...runtimeItem.task,
          children: [{ type: 'subagent', title: '内部检索代理', threadId: 'child' }],
          runtimeHandle: {
            ...runtimeItem.task.runtimeHandle,
            subagents: [{ title: '内部分析代理' }],
          },
        },
      },
    ],
  })
  expect(await screen.findByTestId('stand-in-details-task-task')).toBeVisible()
  expect(screen.queryByText('内部检索代理')).not.toBeInTheDocument()
  expect(screen.queryByText('内部分析代理')).not.toBeInTheDocument()
})
