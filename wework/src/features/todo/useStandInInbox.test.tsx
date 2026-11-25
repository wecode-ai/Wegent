import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import { useStandInInbox } from './useStandInInbox'

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

it('keeps previously recorded owner replies visible without exposing ordinary skips', async () => {
  const skippedWork = (id: string, reason: string): StandInInboxWork => {
    const work = inboxWork(id)
    return {
      ...work,
      source: { ...work.source, delegated: true },
      status: 'sent',
      messageCount: 1,
      delegationResult: { action: 'skip', status: 'complete', reason },
    }
  }
  const ownerReply = skippedWork('owner-reply', 'The account owner already responded.')
  const greeting = skippedWork('greeting', 'This greeting needs no response.')
  const inbox = vi
    .fn<StandInExecutorApi['inbox']>()
    .mockResolvedValue({ items: [ownerReply, greeting], sourceErrors: [] })
  const api = { inbox } as unknown as StandInExecutorApi
  const { result } = renderHook(() => useStandInInbox(api, 7, 'mac'))
  await act(async () => {
    await Promise.resolve()
  })
  expect(result.current.items).toEqual([ownerReply])
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
