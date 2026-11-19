import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import { useStandInInbox } from './useStandInInbox'

it('retains same-scope inbox data on failures and owns polling only while enabled', async () => {
  vi.useFakeTimers()
  try {
    const items = [{ id: 'work' }] as StandInInboxWork[]
    const inbox = vi.fn().mockResolvedValue({ items, sourceErrors: [] })
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
    let finish!: (value: { items: StandInInboxWork[]; sourceErrors: [] }) => void
    const first = {
      inbox: vi.fn(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      ),
    } as unknown as StandInExecutorApi
    const second = {
      inbox: vi.fn().mockResolvedValue({ items: [{ id: 'new' }], sourceErrors: [] }),
    } as unknown as StandInExecutorApi
    const { result, rerender, unmount } = renderHook(({ api }) => useStandInInbox(api, 7, 'mac'), {
      initialProps: { api: first },
    })
    rerender({ api: second })
    expect(result.current.items).toEqual([])
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () =>
      finish({ items: [{ id: 'late' }] as StandInInboxWork[], sourceErrors: [] })
    )
    expect(result.current.items.map(item => item.id)).toEqual(['new'])
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
