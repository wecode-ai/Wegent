import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInProcessingStatus } from '@/api/standIn'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'

afterEach(() => vi.useRealTimers())

it('observes a background failure on the next poll, beyond the ordinary UI wait budget', async () => {
  vi.useFakeTimers()
  const healthy: StandInProcessingStatus = { pendingCount: 1, running: false, actions: [] }
  const failed: StandInProcessingStatus = {
    ...healthy,
    error: { code: 'coordination_stopped', message: 'Assessment stopped' },
  }
  const processingStatus = vi.fn().mockResolvedValue(healthy)
  const api = { processingStatus } as unknown as StandInExecutorApi
  const { result, unmount } = renderHook(() => useStandInProcessingStatus(api, 7, 'device', true))
  await act(async () => {})
  expect(result.current.status).toEqual(healthy)

  processingStatus.mockResolvedValue(failed)
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(processingStatus).toHaveBeenCalledOnce()
  expect(result.current.status?.error).toBeUndefined()

  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(processingStatus).toHaveBeenCalledTimes(2)
  expect(result.current.status?.error).toEqual(failed.error)

  unmount()
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(processingStatus).toHaveBeenCalledTimes(2)
})
