import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import {
  createRuntimeTaskRouteCoordinator,
  resolveRuntimeTaskRoute,
  type RouteInput,
} from './runtimeTaskRouteCoordinator'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'

let lifecycleStore: RuntimeTaskLifecycleStore

const openRuntimeTaskMock = vi.hoisted(() => vi.fn())
const workbenchState = vi.hoisted(() => ({
  currentRuntimeTask: {
    deviceId: 'local-device',
    taskId: 'task-a',
  } as RuntimeTaskAddress | null,
  devices: [] as DeviceInfo[],
  isBootstrapping: false,
  runtimeWork: null,
}))

const routeFixtures = new Set<() => void>()
function renderRoute(initial: { enabled?: boolean; beforeObserve?: () => void } = {}) {
  let enabled = initial.enabled ?? true
  const read = (): RouteInput => ({
    enabled,
    state: workbenchState,
    resolveTask: address =>
      lifecycleStore.selectTask(lifecycleStore.getSnapshot(), address)?.task ?? null,
    openRuntimeTask: openRuntimeTaskMock,
  })
  const actor = createRuntimeTaskRouteCoordinator(read)
  const update = (props?: { enabled: boolean }) => {
    if (props) enabled = props.enabled
    actor.update()
  }
  const stop = () => {
    actor.stop()
    routeFixtures.delete(stop)
  }
  routeFixtures.add(stop)
  initial.beforeObserve?.()
  update()
  return {
    result: {
      get current() {
        return resolveRuntimeTaskRoute(read())
      },
    },
    rerender: update,
    unmount: stop,
  }
}
afterEach(() => {
  for (const stop of routeFixtures) stop()
})

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
    workbenchState.devices = []
    window.history.replaceState({}, '', '/')
  })

  test('switches from the active task to a different runtime task in the URL', async () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')

    renderRoute()

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledWith({
        deviceId: 'local-device',
        taskId: 'task-b',
      })
    )
  })

  test('restores a listed native thread from a project-bound task URL', async () => {
    const address = { deviceId: 'local-device', taskId: 'native-history' }
    const issueExecution = { projectId: 'project-1', issueId: 'issue-1' }
    lifecycleStore.syncRuntimeTask(address, {
      taskId: address.taskId,
      title: 'Native history',
      runtime: 'codex',
      workspacePath: '/known',
      threadId: 'native-thread',
    })
    window.history.replaceState(
      {},
      '',
      '/runtime-tasks?deviceId=local-device&taskId=native-history&issueProjectId=project-1&issueId=issue-1&projectSession=1'
    )

    renderRoute()

    await waitFor(() =>
      expect(openRuntimeTaskMock).toHaveBeenCalledExactlyOnceWith({
        ...address,
        issueExecution,
        projectSession: issueExecution,
        workspacePath: '/known',
        threadId: 'native-thread',
      })
    )
  })

  test('does not restore a task from a stale render after navigation has already changed', () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-b')
    renderRoute({
      beforeObserve: () => {
        window.history.replaceState({}, '', '/stand-in')
        window.dispatchEvent(new PopStateEvent('popstate'))
      },
    })
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
  })

  test('does not reopen the task that is already active', () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=task-a')

    const { result } = renderRoute()

    expect(result.current).toBeNull()
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
  })

  test('keeps the active conversation when its route uses the cloud device alias', () => {
    workbenchState.devices = [
      {
        id: 75,
        device_id: 'electron-local',
        app_device_id: 'electron-local',
        socket_device_id: 'app-record-75',
        device_type: 'local',
        name: 'Local device',
        status: 'online',
      } as DeviceInfo,
    ]
    workbenchState.currentRuntimeTask = {
      deviceId: 'electron-local',
      taskId: 'task-a',
      workspacePath: '/known',
    }
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=app-record-75&taskId=task-a')
    const { result, rerender } = renderRoute()
    expect(result.current).toBeNull()
    workbenchState.currentRuntimeTask = {
      deviceId: 'app-record-75',
      taskId: 'task-a',
      workspacePath: '/known',
    }
    rerender()
    expect(result.current).toBeNull()
    workbenchState.currentRuntimeTask = {
      deviceId: 'electron-local',
      taskId: 'task-a',
      workspacePath: '/known',
    }
    // A local-only refresh precedes the cloud record that supplies the route alias.
    workbenchState.devices = workbenchState.devices.map(device => ({
      ...device,
      app_device_id: undefined,
      socket_device_id: undefined,
    }))
    rerender()
    expect(openRuntimeTaskMock).not.toHaveBeenCalled()
    act(() => {
      window.history.pushState({}, '', '/runtime-tasks?deviceId=other-device&taskId=task-a')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(openRuntimeTaskMock).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'other-device',
      taskId: 'task-a',
    })
  })

  test('restores a newly created task after bootstrap before the work list loads', async () => {
    workbenchState.currentRuntimeTask = null
    workbenchState.isBootstrapping = true
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=first-turn')

    const { rerender } = renderRoute()
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

    const { rerender } = renderRoute({ enabled: false })
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

    renderRoute()

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

  test('does not repeat a failed unlisted metadata read on unrelated renders and retries on tab reveal', async () => {
    workbenchState.currentRuntimeTask = { deviceId: 'local-device', taskId: 'unlisted' }
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=unlisted')
    const { rerender } = renderRoute({ enabled: true })
    await act(async () => {})
    expect(openRuntimeTaskMock).toHaveBeenCalledOnce()
    workbenchState.currentRuntimeTask = { ...workbenchState.currentRuntimeTask }
    rerender({ enabled: true })
    expect(openRuntimeTaskMock).toHaveBeenCalledOnce()
    rerender({ enabled: false })
    rerender({ enabled: true })
    await act(async () => {})
    expect(openRuntimeTaskMock).toHaveBeenCalledTimes(2)
  })
})
