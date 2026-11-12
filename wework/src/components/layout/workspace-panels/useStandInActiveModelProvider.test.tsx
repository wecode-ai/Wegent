import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskSummary } from '@/types/api'
import { useStandInActiveModelProvider } from './useStandInActiveModelProvider'

type ReadResult = Awaited<ReturnType<StandInExecutorApi['readTask']>>
function response(threadId: string, provider: string): ReadResult {
  return {
    success: true,
    task: {
      taskId: 'conversation',
      threadId,
      runtimeHandle: { activeModelProvider: { threadId, provider } },
    } as RuntimeTaskSummary,
  }
}
const address = { deviceId: 'owner', taskId: 'conversation', workspacePath: '/isolated' }
const selection = { modelName: 'same-model', modelType: 'runtime' as const }

describe('legacy stand-in provider identity', () => {
  it('blocks sending while metadata loads and recovers after a failed owner read is refreshed', async () => {
    let resolve!: (value: ReadResult) => void
    const readTask = vi
      .fn<StandInExecutorApi['readTask']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise(done => {
            resolve = done
          })
      )
    const api = { readTask } as unknown as StandInExecutorApi
    const { result } = renderHook(() =>
      useStandInActiveModelProvider({
        enabled: true,
        api,
        address,
        threadId: 'old-thread',
        selection,
        runtimeHandle: undefined,
      })
    )
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.pending).toBe(true)
    act(() => result.current.refresh())
    expect(readTask).toHaveBeenLastCalledWith('owner', 'conversation', {
      resolveActiveProvider: true,
    })
    await act(async () => resolve(response('old-thread', 'openai')))
    expect(result.current).toMatchObject({ provider: 'openai', pending: false, failed: false })
  })

  it('ignores late reads across thread changes and after unmount', async () => {
    const pending: Array<(value: ReadResult) => void> = []
    const readTask = vi
      .fn<StandInExecutorApi['readTask']>()
      .mockImplementation(() => new Promise(done => pending.push(done)))
    const api = { readTask } as unknown as StandInExecutorApi
    const { result, rerender, unmount } = renderHook(
      ({ threadId }) =>
        useStandInActiveModelProvider({
          enabled: true,
          api,
          address,
          threadId,
          selection,
          runtimeHandle: undefined,
        }),
      { initialProps: { threadId: 'old-thread' } }
    )
    rerender({ threadId: 'new-thread' })
    await act(async () => pending[1](response('new-thread', 'router')))
    expect(result.current.provider).toBe('router')
    await act(async () => pending[0](response('old-thread', 'openai')))
    expect(result.current.provider).toBe('router')
    act(() => result.current.refresh())
    unmount()
    await act(async () => pending[2](response('new-thread', 'openai')))
    expect(readTask).toHaveBeenCalledTimes(3)
  })

  it('uses safe cached identity only for its exact current thread and leaves ordinary tasks alone', async () => {
    const readTask = vi
      .fn<StandInExecutorApi['readTask']>()
      .mockResolvedValue(response('new-thread', 'router'))
    const api = { readTask } as unknown as StandInExecutorApi
    const { result, rerender } = renderHook(
      ({ enabled, threadId }) =>
        useStandInActiveModelProvider({
          enabled,
          api,
          address,
          threadId,
          selection,
          runtimeHandle: { activeModelProvider: { threadId: 'old-thread', provider: 'openai' } },
        }),
      { initialProps: { enabled: false, threadId: 'old-thread' } }
    )
    expect(readTask).not.toHaveBeenCalled()
    rerender({ enabled: true, threadId: 'old-thread' })
    expect(result.current.provider).toBe('openai')
    expect(readTask).not.toHaveBeenCalled()
    rerender({ enabled: true, threadId: 'new-thread' })
    await waitFor(() => expect(result.current.provider).toBe('router'))
    expect(readTask).toHaveBeenCalledOnce()
  })
})
