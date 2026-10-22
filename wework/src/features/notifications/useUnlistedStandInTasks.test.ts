import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { RuntimeTaskMachine } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskMachine'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { runtimeItem } from './standInNotifications.fixtures'
import { useUnlistedStandInTasks } from './useUnlistedStandInTasks'
import { standInState } from './standInNotifications'

const readTask = vi.fn()
const getRuntimeTranscript = vi.fn()
const reader = { readTask } as unknown as StandInExecutorApi
const runtimeApi = { getRuntimeTranscript } as unknown as WorkbenchServices['runtimeWorkApi']
function snapshot(completed = false): RuntimeTaskLifecycleStoreSnapshot {
  const machine = new RuntimeTaskMachine(runtimeItem.address)
  machine.dispatch({
    type: 'executor_snapshot_received',
    address: runtimeItem.address,
    task: {
      ...runtimeItem.task,
      runtimeHandle: {},
      ...(completed ? { running: false, status: 'done', completedAt: '2026-10-21T12:04:00Z' } : {}),
    },
  })
  return {
    version: completed ? 2 : 1,
    tasks: new Map([[runtimeItem.key, machine.getSnapshot()]]),
    runningTaskKeys: new Set(),
    queuedTaskKeys: new Set(),
    unreadTaskKeys: new Set(),
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  readTask.mockResolvedValue({ success: true, task: { ...runtimeItem.task, runtimeHandle: {} } })
  getRuntimeTranscript.mockResolvedValue({
    origin: runtimeItem.task.runtimeHandle!.origin,
    messages: [],
    turns: [],
  })
})
afterEach(() => vi.useRealTimers())
describe('unlisted stand-in task discovery', () => {
  it('projects current completion while independently loaded metadata is still running', async () => {
    const current = snapshot(true)
    const hook = renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await waitFor(() => expect(hook.result.current).toHaveLength(1))
    expect(standInState(runtimeItem).status).toBe('running')
    expect(hook.result.current[0].lifecycle).toBe(current.tasks.get(runtimeItem.key))
    expect(standInState(hook.result.current[0]).status).toBe('completed')
  })

  it('recovers a rejected read without needing another lifecycle update', async () => {
    vi.useFakeTimers()
    readTask.mockRejectedValueOnce(new Error('Network unavailable'))
    const current = snapshot()
    const hook = renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await act(async () => {})
    expect(readTask).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(hook.result.current).toHaveLength(1)
  })
  it('bounds rejected reads and clears scheduled retries on unmount', async () => {
    vi.useFakeTimers()
    readTask.mockRejectedValue(new Error('Network unavailable'))
    const current = snapshot()
    const hook = renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(readTask).toHaveBeenCalledTimes(3)
    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
    readTask.mockClear()
    const next = renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await act(async () => {})
    next.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(readTask).toHaveBeenCalledOnce()
  })
  it('does not retry a terminal missing-task response', async () => {
    vi.useFakeTimers()
    readTask.mockResolvedValue({ success: false, code: 'task_not_found' })
    const current = snapshot()
    renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(readTask).toHaveBeenCalledOnce()
  })
  it('ignores a scheduled retry once a newer lifecycle observation succeeds', async () => {
    vi.useFakeTimers()
    readTask.mockRejectedValueOnce(new Error('Network unavailable'))
    const hook = renderHook(({ value }) => useUnlistedStandInTasks([], value, reader, runtimeApi), {
      initialProps: { value: snapshot() },
    })
    await act(async () => {})
    hook.rerender({ value: snapshot(true) })
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(readTask).toHaveBeenCalledTimes(2)
    expect(hook.result.current).toHaveLength(1)
  })
  it('reads authoritative task metadata when sidebar project filters hide the execution', async () => {
    const current = snapshot()
    const hook = renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await waitFor(() => expect(hook.result.current).toHaveLength(1))
    expect(readTask).toHaveBeenCalledExactlyOnceWith('device', 'task')
    expect(hook.result.current[0].task.runtimeHandle?.origin).toMatchObject({
      initiatedBy: 'stand_in',
    })
  })
  it('keeps the newer observation when task state changes while metadata is loading', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    readTask.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
    const hook = renderHook(({ value }) => useUnlistedStandInTasks([], value, reader, runtimeApi), {
      initialProps: { value: snapshot() },
    })
    hook.rerender({ value: snapshot(true) })
    resolvers[1]({
      success: true,
      task: { ...runtimeItem.task, title: 'Latest', running: false, status: 'done' },
    })
    await waitFor(() => expect(hook.result.current[0]?.task.title).toBe('Latest'))
    await act(async () =>
      resolvers[0]({ success: true, task: { ...runtimeItem.task, title: 'Stale' } })
    )
    expect(getRuntimeTranscript).toHaveBeenCalledOnce()
    expect(hook.result.current[0].task.title).toBe('Latest')
  })
  it('does not duplicate visible tasks or include unrelated runtime conversations', async () => {
    const current = snapshot()
    renderHook(() => useUnlistedStandInTasks([runtimeItem], current, reader, runtimeApi))
    expect(readTask).not.toHaveBeenCalled()
    getRuntimeTranscript.mockResolvedValue({
      origin: { type: 'board_comment' },
      messages: [],
      turns: [],
    })
    const hook = renderHook(() => useUnlistedStandInTasks([], current, reader, runtimeApi))
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledOnce())
    expect(hook.result.current).toEqual([])
  })
  it('preserves the latest task when an older metadata request fails', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    readTask.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
    const hook = renderHook(({ value }) => useUnlistedStandInTasks([], value, reader, runtimeApi), {
      initialProps: { value: snapshot() },
    })
    hook.rerender({ value: snapshot(true) })
    resolvers[1]({ success: true, task: { ...runtimeItem.task, title: 'Latest' } })
    await waitFor(() => expect(hook.result.current[0]?.task.title).toBe('Latest'))
    await act(async () => resolvers[0]({ success: false }))
    expect(hook.result.current[0]?.task.title).toBe('Latest')
  })
  it('does not re-read confirmed ordinary tasks when their lifecycle advances', async () => {
    getRuntimeTranscript.mockResolvedValue({
      origin: { initiatedBy: 'user' },
      messages: [],
      turns: [],
    })
    const hook = renderHook(({ value }) => useUnlistedStandInTasks([], value, reader, runtimeApi), {
      initialProps: { value: snapshot() },
    })
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledOnce())
    hook.rerender({ value: snapshot(true) })
    expect(readTask).toHaveBeenCalledOnce()
    expect(hook.result.current).toEqual([])
  })
})
