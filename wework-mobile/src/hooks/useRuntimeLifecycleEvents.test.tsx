import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTaskLifecycleProjection } from '@/domain/runtimeTaskLifecycle'
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
