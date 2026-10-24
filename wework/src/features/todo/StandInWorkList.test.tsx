import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import '@/i18n'
import { inboxRuntimeItem } from './useStandInInbox'
import { StandInWorkList } from './StandInWorkList'
import { RuntimeTaskMachine } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskMachine'
import { standInState } from '@/features/notifications/standInNotifications'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'

function work(id = 'work'): StandInInboxWork {
  return {
    id,
    taskId: id,
    roleId: 'review',
    title: '评审方案',
    status: 'pending',
    updatedAt: '2026-10-24T00:00:00Z',
    source: {
      id: 'group',
      profile: 'corp:user',
      name: '项目讨论群',
      kind: 'group',
      policy: { automatic: false, askBeforeAct: true },
    },
    messageCount: 1,
    latestMessage: {
      id: 'message',
      recordId: 'record',
      senderId: 'alice',
      text: '请检查这份方案',
      at: '2026-10-24T00:00:00Z',
      source: {
        id: 'group',
        profile: 'corp:user',
        name: '项目讨论群',
        kind: 'group',
        policy: { automatic: false, askBeforeAct: true },
      },
    },
  }
}

it('previews pending work without executing and starts it only through an explicit action for local user 0', async () => {
  const user = userEvent.setup()
  const item = work()
  const runWork = vi.fn(async () => ({ deviceId: 'device', taskId: 'work' }))
  const open = vi.fn()
  const api = {
    runWork,
    workMessages: vi.fn(async () => ({ messages: [item.latestMessage] })),
  } as unknown as StandInExecutorApi
  render(
    <StandInWorkList
      items={[inboxRuntimeItem(item, 'device')]}
      inbox={[item]}
      api={api}
      userId={0}
      deviceId="device"
      onOpenTask={open}
    />
  )
  await user.click(screen.getByTestId('stand-in-activity-task-work'))
  expect(screen.getByTestId('stand-in-preview-summary')).toHaveTextContent('请检查这份方案')
  expect(runWork).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-preview-open'))
  expect(runWork).toHaveBeenCalledWith(0, 'device', 'work')
  expect(open).toHaveBeenCalledWith({ deviceId: 'device', taskId: 'work' })
})

it('limits manual message moves to this role and sends the durable record ID', async () => {
  const user = userEvent.setup()
  const item = work()
  const target = work('target')
  const otherRole = { ...work('other-role'), roleId: 'other' }
  const adjustMessage = vi.fn(async () => target)
  const api = {
    adjustMessage,
    workMessages: vi.fn(async () => ({ messages: [item.latestMessage] })),
  } as unknown as StandInExecutorApi
  render(
    <StandInWorkList
      items={[inboxRuntimeItem(item, 'device')]}
      inbox={[item, target, otherRole]}
      api={api}
      userId={7}
      deviceId="device"
    />
  )
  await user.click(screen.getByTestId('stand-in-activity-task-work'))
  await user.click(screen.getByTestId('stand-in-work-messages-toggle'))
  const select = await screen.findByTestId('stand-in-message-move-message')
  expect(select.querySelector('option[value="other-role"]')).toBeNull()
  await user.selectOptions(select, 'target')
  expect(adjustMessage).toHaveBeenCalledWith(7, 'device', 'work', 'record', 'target')
})

it('supports an empty original association after its last message moves elsewhere', () => {
  const empty = { ...work(), messageCount: 0, latestMessage: null }
  expect(inboxRuntimeItem(empty, 'device').task.title).toBe('评审方案')
})

it('keeps authoritative turn completion when inbox task metadata still says active', () => {
  const item = work(runtimeItem.task.taskId)
  const machine = new RuntimeTaskMachine(runtimeItem.address)
  machine.dispatch({
    type: 'executor_snapshot_received',
    address: runtimeItem.address,
    task: { ...runtimeItem.task, status: 'done', running: false },
  })
  const current = { ...runtimeItem, lifecycle: machine.getSnapshot() }
  const stale = {
    ...item,
    status: 'sent' as const,
    task: { ...runtimeItem.task, status: 'active', running: false },
  }
  expect(standInState(inboxRuntimeItem(stale, 'device', current)).status).toBe('completed')
})
