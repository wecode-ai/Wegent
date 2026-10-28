import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const organizeWork = vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(item)
  const api = {
    organizeWork,
    workMessages: vi.fn(async () => ({ messages: [item.latestMessage] })),
  } as unknown as StandInExecutorApi
  render(
    <StandInWorkList
      items={[item, target, otherRole].map(value => inboxRuntimeItem(value, 'device'))}
      inbox={[item, target, otherRole]}
      api={api}
      userId={7}
      deviceId="device"
    />
  )
  await user.click(screen.getByTestId('stand-in-activity-task-work'))
  await user.click(screen.getByTestId('stand-in-work-messages-toggle'))
  await user.click(await screen.findByTestId('stand-in-message-move-message'))
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-activity-task-other-role'))
  expect(organizeWork).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-activity-task-target'))
  await screen.findByTestId('stand-in-organization-done')
  expect(organizeWork).toHaveBeenCalledWith(7, 'device', 'work', ['record'], 'target', 'move')
  await user.click(screen.getByTestId('stand-in-organization-undo'))
  await waitFor(() =>
    expect(organizeWork).toHaveBeenLastCalledWith(7, 'device', 'target', ['record'], 'work', 'undo')
  )
})

it('merges complete work through a direct drop in one atomic request', async () => {
  const source = work()
  const target = work('target')
  const organizeWork = vi.fn(async () => target)
  const api = {
    organizeWork,
    workMessages: vi.fn(async () => ({
      messages: [source.latestMessage, { ...source.latestMessage, recordId: 'second' }],
    })),
  } as unknown as StandInExecutorApi
  render(
    <StandInWorkList
      items={[source, target].map(value => inboxRuntimeItem(value, 'device'))}
      inbox={[source, target]}
      api={api}
      userId={7}
      deviceId="device"
    />
  )
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(screen.getByTestId('stand-in-activity-task-work'), { dataTransfer })
  fireEvent.dragOver(screen.getByTestId('stand-in-activity-task-target'), { dataTransfer })
  expect(screen.getByTestId('stand-in-activity-task-target')).toHaveTextContent('松开')
  fireEvent.drop(screen.getByTestId('stand-in-activity-task-target'), { dataTransfer })
  await waitFor(() =>
    expect(organizeWork).toHaveBeenCalledExactlyOnceWith(
      7,
      'device',
      'work',
      ['record', 'second'],
      'target',
      'merge'
    )
  )
})

it('splits a message directly with an accessible button and offers undo', async () => {
  const user = userEvent.setup()
  const source = { ...work(), messageCount: 2 }
  const separated = work('separated')
  const organizeWork = vi.fn(async () => separated)
  const api = {
    organizeWork,
    workMessages: vi.fn(async () => ({
      messages: [
        source.latestMessage,
        { ...source.latestMessage, id: 'second', recordId: 'second' },
      ],
    })),
  } as unknown as StandInExecutorApi
  render(
    <StandInWorkList
      items={[inboxRuntimeItem(source, 'device')]}
      inbox={[source]}
      api={api}
      userId={7}
      deviceId="device"
    />
  )
  await user.click(screen.getByTestId('stand-in-activity-task-work'))
  await user.click(screen.getByTestId('stand-in-work-split'))
  await user.click(await screen.findByTestId('stand-in-message-split-message'))
  await screen.findByTestId('stand-in-organization-done')
  expect(organizeWork).toHaveBeenCalledExactlyOnceWith(
    7,
    'device',
    'work',
    ['record'],
    undefined,
    'split'
  )
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

it('projects completed history without a runtime task as completed', () => {
  expect(standInState(inboxRuntimeItem({ ...work(), status: 'sent' }, 'device')).status).toBe(
    'completed'
  )
})
