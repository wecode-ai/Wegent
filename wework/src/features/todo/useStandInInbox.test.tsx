import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { inboxRuntimeItem, useStandInInbox } from './useStandInInbox'

function inboxWork(id: string): StandInInboxWork {
  return {
    id,
    taskId: `task-${id}`,
    roleId: 'assistant-role',
    title: 'Incoming work',
    source: {
      providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
      id: 'group-1',
      profile: 'dingtalk',
      name: 'Test group',
      kind: 'group',
      policy: { automatic: true, askBeforeAct: false },
    },
    status: 'pending',
    updatedAt: '2026-01-01T00:00:00Z',
    messageCount: 0,
    latestMessage: null,
  }
}

it('prefers the backend-filtered task summary over a stale runtime snapshot', () => {
  const work = {
    ...inboxWork('visible'),
    messageCount: 1,
    task: {
      taskId: 'task-visible',
      title: 'Visible title',
      runtime: 'codex' as const,
      workspacePath: '',
      running: false,
      error: null,
    },
  }
  const runtimeItem = {
    key: 'mac\0task-visible',
    address: { deviceId: 'mac', taskId: 'task-visible' },
    task: {
      taskId: 'task-visible',
      title: 'Hidden account title',
      error: 'Hidden account error',
      runtime: 'codex',
      workspacePath: '',
      status: 'running',
      updatedAt: 1,
    },
    workspace: { deviceId: 'mac', available: true, workspacePath: '', tasks: [] },
    projectName: 'Stale project',
  } as unknown as RuntimeTaskReminderItem

  const item = inboxRuntimeItem(work, 'mac', runtimeItem)

  expect(item.task.title).toBe('Visible title')
  expect(item.task.error).toBeUndefined()

  const fallback = inboxRuntimeItem(
    { ...inboxWork('fallback'), messageCount: 1 },
    'mac',
    runtimeItem
  )
  expect(fallback.task.title).toBe('Incoming work')
  expect(fallback.task.error).toBeUndefined()
})

it('retains same-scope inbox data on failures and owns polling only while enabled', async () => {
  vi.useFakeTimers()
  try {
    const items = [inboxWork('work')]
    const inbox = vi
      .fn<StandInExecutorApi['inbox']>()
      .mockResolvedValue({ items, sourceErrors: [] })
    const api = { inbox } as unknown as StandInExecutorApi
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useStandInInbox(api, 7, 'mac', enabled),
      { initialProps: { enabled: false } }
    )
    expect(result.current.scope).toBeUndefined()
    expect(inbox).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    rerender({ enabled: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.scope).toBe('7:mac')
    expect(result.current.items).toEqual(items)
    inbox.mockRejectedValueOnce({ code: 'device_offline' })
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(result.current.items).toEqual(items)
    expect(result.current.error).toContain('执行设备离线')
    await act(async () => {
      result.current.refresh()
    })
    expect(result.current.error).toBeNull()
    expect(inbox).toHaveBeenCalledTimes(3)
    rerender({ enabled: false })
    expect(vi.getTimerCount()).toBe(0)
    act(() => result.current.refresh())
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(inbox).toHaveBeenCalledTimes(3)
    rerender({ enabled: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(inbox).toHaveBeenCalledTimes(4)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('isolates an API change and refuses to restart polling after a detached read settles', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: Awaited<ReturnType<StandInExecutorApi['inbox']>>) => void
    const first = {
      inbox: vi.fn<StandInExecutorApi['inbox']>(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      ),
    } as unknown as StandInExecutorApi
    const second = {
      inbox: vi
        .fn<StandInExecutorApi['inbox']>()
        .mockResolvedValue({ items: [inboxWork('new')], sourceErrors: [] }),
    } as unknown as StandInExecutorApi
    const { result, rerender, unmount } = renderHook(({ api }) => useStandInInbox(api, 7, 'mac'), {
      initialProps: { api: first },
    })
    rerender({ api: second })
    expect(result.current.items).toEqual([])
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => finish({ items: [inboxWork('late')], sourceErrors: [] }))
    expect(result.current.items.map(item => item.id)).toEqual(['new'])
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
