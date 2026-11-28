import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTaskLifecycleProjection } from '@/domain/runtimeTaskLifecycle'
import {
  clearMobileTaskOutcomes,
  recordMobileTaskOutcome,
  takeMobileTaskOutcome,
} from '@/telemetry/taskOutcome'
import { useRuntimeLifecycleEvents } from './useRuntimeLifecycleEvents'
import type { RuntimeStream } from '@/services/runtimeStream'
const errorAlert = vi.hoisted(() => vi.fn())
vi.mock('@/services/errorAlerts', () => ({ showErrorAlert: errorAlert }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(() => renderer?.unmount())
  vi.clearAllMocks()
  clearMobileTaskOutcomes()
})
it('reports asynchronous archived deletion failure even without an active conversation', async () => {
  let listener!: Parameters<RuntimeStream['subscribeLifecycle']>[0]
  const reloadTranscript = vi.fn()
  const commitDeviceWork = vi.fn()
  const stream = {
    subscribeLifecycle: vi.fn(callback => {
      listener = callback
      return () => {}
    }),
  } as unknown as RuntimeStream
  function Harness() {
    useRuntimeLifecycleEvents({
      stream,
      lifecycle: new RuntimeTaskLifecycleProjection(),
      currentAddressRef: { current: null },
      workByDeviceRef: { current: {} },
      setCurrentAddress: vi.fn(),
      commitDeviceWork,
      publishTaskLifecycle: vi.fn(),
      reloadTranscript,
    })
    return null
  }
  await act(() => {
    renderer = create(<Harness />)
  })
  listener(
    { deviceId: 'app-record-11', taskId: 'archived-task' },
    {
      name: 'runtime.work.changed',
      payload: {
        data: {
          archiveCleanup: { workspacePath: '/managed/task', errors: ['Snapshot unavailable'] },
        },
      },
    }
  )
  expect(errorAlert).toHaveBeenCalledExactlyOnceWith(new Error('Snapshot unavailable'), {
    title: '已归档会话的文件清理失败',
  })
  expect(reloadTranscript).not.toHaveBeenCalled()
  expect(commitDeviceWork).not.toHaveBeenCalled()
  errorAlert.mockClear()
  listener(
    { deviceId: 'app-record-11', taskId: 'archived-task' },
    {
      name: 'runtime.work.changed',
      payload: { data: { archiveCleanup: { workspacePath: '/managed/task', errors: [] } } },
    }
  )
  expect(errorAlert).not.toHaveBeenCalled()
})

it('stops a background task and clears its old outcome before the next run', async () => {
  let listener!: Parameters<RuntimeStream['subscribeLifecycle']>[0]
  const lifecycle = new RuntimeTaskLifecycleProjection()
  const publishTaskLifecycle = vi.fn()
  const stream = {
    subscribeLifecycle: vi.fn(callback => {
      listener = callback
      return () => {}
    }),
  } as unknown as RuntimeStream
  function Harness() {
    useRuntimeLifecycleEvents({
      stream,
      lifecycle,
      currentAddressRef: { current: null },
      workByDeviceRef: { current: {} },
      setCurrentAddress: vi.fn(),
      commitDeviceWork: vi.fn(),
      publishTaskLifecycle,
      reloadTranscript: vi.fn(),
    })
    return null
  }
  await act(() => {
    renderer = create(<Harness />)
  })
  const address = {
    deviceId: 'app-record-11',
    taskId: 'background-task',
    runtime: 'codex' as const,
  }
  recordMobileTaskOutcome(address, 'runtime.task.cancelled')

  listener(address, { name: 'runtime.task.status', payload: {} })
  expect(lifecycle.snapshot().get(JSON.stringify([address.deviceId, address.taskId]))).toBe(true)
  expect(takeMobileTaskOutcome(address)).toBeNull()

  listener(address, { name: 'runtime.task.failed', payload: {} })
  expect(lifecycle.snapshot().get(JSON.stringify([address.deviceId, address.taskId]))).toBe(false)
  expect(takeMobileTaskOutcome(address)).toBe('failure')
  expect(publishTaskLifecycle).toHaveBeenCalledTimes(2)
})

it('keeps an outcome that arrives while a send is already projected as running', async () => {
  let listener!: Parameters<RuntimeStream['subscribeLifecycle']>[0]
  const lifecycle = new RuntimeTaskLifecycleProjection()
  const stream = {
    subscribeLifecycle: vi.fn(callback => {
      listener = callback
      return () => {}
    }),
  } as unknown as RuntimeStream
  function Harness() {
    useRuntimeLifecycleEvents({
      stream,
      lifecycle,
      currentAddressRef: { current: null },
      workByDeviceRef: { current: {} },
      setCurrentAddress: vi.fn(),
      commitDeviceWork: vi.fn(),
      publishTaskLifecycle: vi.fn(),
      reloadTranscript: vi.fn(),
    })
    return null
  }
  await act(() => {
    renderer = create(<Harness />)
  })
  const address = { deviceId: 'app-record-11', taskId: 'fast-task', runtime: 'codex' as const }
  lifecycle.sendRequested(address)
  recordMobileTaskOutcome(address, 'runtime.task.failed')

  listener(address, { name: 'runtime.task.status', payload: {} })

  expect(takeMobileTaskOutcome(address)).toBe('failure')
})
