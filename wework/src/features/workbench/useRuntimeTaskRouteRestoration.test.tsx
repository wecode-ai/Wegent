import { act, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleProvider, RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useRuntimeTaskRouteRestoration } from './useRuntimeTaskRouteRestoration'

let lifecycleStore: RuntimeTaskLifecycleStore
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RuntimeTaskLifecycleProvider store={lifecycleStore}>{children}</RuntimeTaskLifecycleProvider>
)

const openRuntimeTaskMock = vi.hoisted(() => vi.fn())
const workbenchState = vi.hoisted(() => ({
  currentRuntimeTask: {
    deviceId: 'local-device',
    taskId: 'task-a',
  } as { deviceId: string; taskId: string } | null,
  isBootstrapping: false,
  runtimeWork: null,
}))

vi.mock('./useWorkbench', () => ({
  useWorkbench: () => ({
    state: workbenchState,
    openRuntimeTask: openRuntimeTaskMock,
  }),
}))

describe('useRuntimeTaskRouteRestoration', () => {
  beforeEach(() => {
    lifecycleStore = new RuntimeTaskLifecycleStore('route-test')
    lifecycleStore.syncRuntimeTask(
      { deviceId: 'local-device', taskId: 'task-a' },
      {
        taskId: 'task-a',
        title: 'Known task',
        runtime: 'codex',
        workspacePath: '/known',
      }
    )
    openRuntimeTaskMock.mockReset()
    openRuntimeTaskMock.mockResolvedValue(undefined)
    workbenchState.currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'task-a',
    }
    workbenchState.isBootstrapping = false
    window.history.replaceState({}, '', '/')
  })

  test('switches from the active task to a different runtime task in the URL', async () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')

    renderHook(() => useRuntimeTaskRouteRestoration(), { wrapper })

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledWith({
        deviceId: 'local-device',
        taskId: 'task-b',
      })
    )
  })

  test('does not restore a task from a stale render after navigation has already changed', () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')
    renderHook(
      () => {
        useRuntimeTaskRouteRestoration()
        useLayoutEffect(() => {
          window.history.replaceState({}, '', '/stand-in')
          window.dispatchEvent(new PopStateEvent('popstate'))
        }, [])
      },
      { wrapper }
    )
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
  })

  test('does not reopen the task that is already active', () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-a')

    const { result } = renderHook(() => useRuntimeTaskRouteRestoration(), { wrapper })

    expect(result.current).toBeNull()
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
  })

  test('restores a newly created task after bootstrap before the work list loads', async () => {
    workbenchState.currentRuntimeTask = null
    workbenchState.isBootstrapping = true
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=first-turn')

    const { rerender } = renderHook(() => useRuntimeTaskRouteRestoration(), { wrapper })
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()

    workbenchState.isBootstrapping = false
    rerender()

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledExactlyOnceWith({
        deviceId: 'local-device',
        taskId: 'first-turn',
      })
    )
  })

  test('restores the notification destination when its new tab becomes active', async () => {
    workbenchState.currentRuntimeTask = null
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=first-turn')

    const { rerender } = renderHook(({ enabled }) => useRuntimeTaskRouteRestoration(enabled), {
      initialProps: { enabled: false },
      wrapper,
    })
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
    rerender({ enabled: true })

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledExactlyOnceWith({
        deviceId: 'local-device',
        taskId: 'first-turn',
      })
    )
  })

  test('switches tasks when navigation changes only the URL query', async () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-a')

    renderHook(() => useRuntimeTaskRouteRestoration(), { wrapper })

    act(() => {
      window.history.pushState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledWith({
        deviceId: 'local-device',
        taskId: 'task-b',
      })
    )
  })

  test('does not repeat a failed unlisted metadata read on unrelated renders and retries on tab reveal', () => {
    workbenchState.currentRuntimeTask = { deviceId: 'local-device', taskId: 'unlisted' }
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=unlisted')
    const { rerender } = renderHook(({ enabled }) => useRuntimeTaskRouteRestoration(enabled), {
      initialProps: { enabled: true },
      wrapper,
    })
    expect(openRuntimeTaskMock).toHaveBeenCalledOnce()
    workbenchState.currentRuntimeTask = { ...workbenchState.currentRuntimeTask }
    rerender({ enabled: true })
    expect(openRuntimeTaskMock).toHaveBeenCalledOnce()
    rerender({ enabled: false })
    rerender({ enabled: true })
    expect(openRuntimeTaskMock).toHaveBeenCalledTimes(2)
  })
})
