import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInProcessingStatus } from '@/api/standIn'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'

const status = { running: false, awaitingUser: false } as StandInProcessingStatus

it('suspends polling while disabled and rejects a previous API response', async () => {
  let finish!: (value: StandInProcessingStatus) => void
  const first = {
    processingStatus: vi.fn(
      () =>
        new Promise<StandInProcessingStatus>(resolve => {
          finish = resolve
        })
    ),
  } as unknown as StandInExecutorApi
  const second = {
    processingStatus: vi.fn().mockResolvedValue({ ...status, taskId: 'new' }),
  } as unknown as StandInExecutorApi
  const { result, rerender, unmount } = renderHook(
    ({ api, enabled }) => useStandInProcessingStatus(api, 7, 'mac', enabled),
    { initialProps: { api: first, enabled: false } }
  )
  expect(first.processingStatus).not.toHaveBeenCalled()
  rerender({ api: first, enabled: true })
  expect(first.processingStatus).toHaveBeenCalledTimes(1)
  rerender({ api: second, enabled: true })
  expect(result.current.status).toBeNull()
  await waitFor(() => expect(result.current.status?.taskId).toBe('new'))
  await act(async () => finish({ ...status, taskId: 'old' }))
  expect(result.current.status?.taskId).toBe('new')
  rerender({ api: second, enabled: false })
  expect(result.current.status).toBeNull()
  expect(result.current.error).toBeNull()
  unmount()
})

it('retains status on read failure and allows explicit status and error updates', async () => {
  vi.useFakeTimers()
  try {
    const processingStatus = vi.fn().mockResolvedValue(status)
    const api = { processingStatus } as unknown as StandInExecutorApi
    const { result, unmount } = renderHook(() => useStandInProcessingStatus(api, 7, 'mac', true))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status).toBe(status)
    processingStatus.mockRejectedValueOnce({ code: 'device_offline' })
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(result.current.status).toBe(status)
    expect(result.current.error).toContain('执行设备离线')
    act(() => result.current.setStatus({ ...status, taskId: 'checked' }))
    expect(result.current.status?.taskId).toBe('checked')
    expect(result.current.error).toContain('执行设备离线')
    act(() => result.current.setError(null))
    expect(result.current.error).toBeNull()
    expect(result.current.status?.taskId).toBe('checked')
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
