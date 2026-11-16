import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import { standInState } from '@/features/notifications/standInNotifications'
import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { StandInWorkList } from './StandInWorkList'
import { inboxRuntimeItem } from './useStandInInbox'

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

it.each(['pending', 'failed', 'needs_grouping'] as const)(
  'opens the original task awaiting input without restarting %s source work',
  async status => {
    const user = userEvent.setup()
    const item: StandInInboxWork = {
      ...work(),
      status,
      task: {
        taskId: 'work',
        title: '评审方案',
        runtime: 'codex',
        workspacePath: '/workspace',
        status: 'running',
        running: true,
        interactionStatus: 'awaitingUserReply',
        updatedAt: '2026-10-24T00:00:00Z',
      },
    }
    const runWork = vi.fn(async () => ({ deviceId: 'device', taskId: 'unexpected-restart' }))
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
        userId={7}
        deviceId="device"
        onOpenTask={open}
      />
    )
    await user.click(screen.getByTestId('stand-in-activity-task-work'))
    await user.click(screen.getByTestId('stand-in-preview-open'))
    expect(runWork).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'device', taskId: 'work' })
    expect(screen.getByTestId('stand-in-preview-open')).toHaveTextContent('进入工作处理')
  }
)

it('retains the explicit retry action for a terminal failed task', async () => {
  const item: StandInInboxWork = {
    ...work(),
    status: 'failed',
    task: {
      taskId: 'work',
      title: '评审方案',
      runtime: 'codex',
      workspacePath: '/workspace',
      status: 'failed',
      running: false,
      updatedAt: '2026-10-24T00:00:00Z',
    },
  }
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
      userId={7}
      deviceId="device"
      onOpenTask={open}
    />
  )
  await userEvent.click(screen.getByTestId('stand-in-activity-task-work'))
  expect(runWork).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-preview-confirm-once')).toBeInTheDocument()
  const retry = screen.getByTestId('stand-in-preview-open')
  expect(retry).toHaveTextContent('交给角色处理')
  await userEvent.click(retry)
  expect(runWork).toHaveBeenCalledExactlyOnceWith(7, 'device', 'work')
  expect(open).toHaveBeenCalledWith({ deviceId: 'device', taskId: 'work' })
})

it('restores archived source work explicitly without starting a turn or opening a conversation', async () => {
  const item: StandInInboxWork = {
    ...work(),
    task: {
      taskId: 'work',
      title: '评审方案',
      runtime: 'codex',
      workspacePath: '/workspace',
      status: 'archived',
      running: false,
      updatedAt: '2026-10-24T00:00:00Z',
    },
  }
  const restore = vi
    .fn()
    .mockRejectedValueOnce(new Error('Restore failed'))
    .mockResolvedValueOnce(undefined)
  const runWork = vi.fn()
  const open = vi.fn()
  const refresh = vi.fn()
  const stale = inboxRuntimeItem({ ...item, task: { ...item.task!, status: 'done' } }, 'device')
  const api = {
    runWork,
    workMessages: vi.fn(async () => ({ messages: [item.latestMessage] })),
  } as unknown as StandInExecutorApi
  render(
    <StandInWorkList
      items={[inboxRuntimeItem(item, 'device', stale)]}
      inbox={[item]}
      api={api}
      userId={7}
      deviceId="device"
      onRestoreTask={restore}
      onOpenTask={open}
      onRefresh={refresh}
    />
  )
  await userEvent.click(screen.getByTestId('stand-in-activity-task-work'))
  expect(restore).not.toHaveBeenCalled()
  const action = screen.getByTestId('stand-in-preview-open')
  expect(action).toHaveTextContent('取消归档')
  await userEvent.click(action)
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法完成此操作')
  await userEvent.click(action)
  expect(restore).toHaveBeenLastCalledWith({ deviceId: 'device', taskId: 'work' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(runWork).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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

it('projects completed history without a runtime task as completed', () => {
  expect(standInState(inboxRuntimeItem({ ...work(), status: 'sent' }, 'device')).status).toBe(
    'completed'
  )
})

it.each(['done', 'running'] as const)(
  'does not offer to confirm and execute an already %s work',
  async status => {
    const user = userEvent.setup()
    const item: StandInInboxWork = {
      ...work(),
      status: 'failed',
      task: {
        taskId: 'work',
        title: '评审方案',
        runtime: 'codex',
        workspacePath: '/workspace',
        status,
        running: status === 'running',
        updatedAt: '2026-10-24T00:00:00Z',
        turnStatus: status === 'done' ? 'completed' : 'inProgress',
      },
    }
    const runWork = vi.fn()
    render(
      <StandInWorkList
        items={[inboxRuntimeItem(item, 'device')]}
        inbox={[item]}
        api={
          {
            runWork,
            workMessages: vi.fn(async () => ({ messages: [item.latestMessage] })),
          } as unknown as StandInExecutorApi
        }
        userId={0}
        deviceId="device"
      />
    )
    await user.click(screen.getByTestId('stand-in-activity-task-work'))
    expect(screen.queryByTestId('stand-in-preview-confirm-once')).not.toBeInTheDocument()
    expect(runWork).not.toHaveBeenCalled()
  }
)
