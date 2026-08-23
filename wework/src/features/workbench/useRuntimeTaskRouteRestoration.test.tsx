import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useRuntimeTaskRouteRestoration } from './useRuntimeTaskRouteRestoration'

const openRuntimeTaskMock = vi.hoisted(() => vi.fn())
const workbenchState = vi.hoisted(() => ({
  currentRuntimeTask: {
    deviceId: 'local-device',
    taskId: 'task-a',
  } as { deviceId: string; taskId: string } | null,
  isBootstrapping: false,
  runtimeWork: { projects: [], chats: [], totalTasks: 0 } as {
    projects: unknown[]
    chats: unknown[]
    totalTasks: number
  } | null,
}))

vi.mock('./useWorkbench', () => ({
  useWorkbench: () => ({
    state: workbenchState,
    openRuntimeTask: openRuntimeTaskMock,
  }),
}))

describe('useRuntimeTaskRouteRestoration', () => {
  beforeEach(() => {
    openRuntimeTaskMock.mockReset()
    openRuntimeTaskMock.mockResolvedValue(undefined)
    workbenchState.currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'task-a',
    }
    workbenchState.isBootstrapping = false
    workbenchState.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    window.history.replaceState({}, '', '/')
  })

  test('waits for the initial runtime work discovery before restoring a route', () => {
    workbenchState.runtimeWork = null
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')

    const { result } = renderHook(() => useRuntimeTaskRouteRestoration())

    expect(result.current).toBeNull()
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
  })

  test('switches from the active task to a different runtime task in the URL', async () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')

    renderHook(() => useRuntimeTaskRouteRestoration())

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledWith({
        deviceId: 'local-device',
        taskId: 'task-b',
      })
    )
  })

  test('does not reopen the task that is already active', () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-a')

    const { result } = renderHook(() => useRuntimeTaskRouteRestoration())

    expect(result.current).toBeNull()
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
  })

  test('switches tasks when navigation changes only the URL query', async () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-a')

    renderHook(() => useRuntimeTaskRouteRestoration())

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
})
