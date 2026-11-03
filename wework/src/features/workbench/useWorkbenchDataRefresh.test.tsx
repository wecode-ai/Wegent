import { act, renderHook, waitFor } from '@testing-library/react'
import { useReducer } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ExecutorClient } from '@/api/executorAccess'
import { LOCAL_USER } from '@/api/local/localSession'
import type { DeviceInfo, RuntimeWorkListResponse, User } from '@/types/api'
import type { WorkbenchServices } from './workbenchServices'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

const work: RuntimeWorkListResponse = {
  projects: [],
  chats: [
    {
      deviceId: 'local-device',
      workspacePath: '/workspace',
      available: true,
      tasks: [{ taskId: 'task-1', workspacePath: '/workspace', title: 'Task', runtime: 'codex' }],
    },
  ],
  totalTasks: 1,
}
const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'local-device',
    name: 'Local',
    status: 'online',
    device_type: 'local',
    is_default: true,
  },
]
const services = {} as WorkbenchServices

function setup(
  listRuntimeWork = vi.fn().mockResolvedValue(work),
  listDevices = vi.fn().mockResolvedValue(devices)
) {
  const executorClient = {
    runtime: { listRuntimeWork },
    commands: { listDevices },
  } as unknown as ExecutorClient
  const hook = renderHook(
    ({ user, client }: { user: User; client: ExecutorClient }) => {
      const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
      const actions = useWorkbenchDataRefresh({
        user,
        executorClient: client,
        services,
        state,
        dispatch,
      })
      return { state, ...actions }
    },
    { initialProps: { user: LOCAL_USER, client: executorClient } }
  )
  return { ...hook, executorClient, listRuntimeWork, listDevices }
}

describe('useWorkbenchDataRefresh', () => {
  beforeEach(() => localStorage.clear())

  test('publishes initial tasks without waiting for device discovery', async () => {
    const pendingDevices = deferred<DeviceInfo[]>()
    const hook = setup(undefined, vi.fn().mockReturnValue(pendingDevices.promise))
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
    expect(hook.result.current.state.devices).toEqual([])
    await act(async () => pendingDevices.resolve(devices))
    expect(hook.result.current.state.devices[0]?.device_id).toBe('local-device')
  })

  test('publishes devices while initial task loading is pending', async () => {
    const pendingWork = deferred<RuntimeWorkListResponse>()
    const hook = setup(vi.fn().mockReturnValue(pendingWork.promise))
    await waitFor(() => expect(hook.result.current.state.devices).toHaveLength(1))
    expect(hook.result.current.state.runtimeWork).toBeNull()
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('loading')
    await act(async () => pendingWork.resolve({ projects: [], chats: [], totalTasks: 0 }))
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(0)
  })

  test('finishes shell bootstrap with the latest device response and ignores late discovery', async () => {
    const initialDevices = deferred<DeviceInfo[]>()
    const latestDevices = devices.map(device => ({ ...device, name: 'Refreshed device' }))
    const listDevices = vi
      .fn()
      .mockReturnValueOnce(initialDevices.promise)
      .mockResolvedValueOnce(latestDevices)
    const hook = setup(undefined, listDevices)
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    await act(async () => hook.result.current.refreshWorkLists())
    expect(hook.result.current.state.isBootstrapping).toBe(false)
    expect(hook.result.current.state.user?.id).toBe(LOCAL_USER.id)
    await act(async () => initialDevices.resolve(devices))
    expect(hook.result.current.state.devices[0]?.name).toBe('Refreshed device')
  })

  test('exposes an initial failure and recovers through an explicit refresh', async () => {
    const listWork = vi
      .fn()
      .mockRejectedValueOnce(new Error('History busy'))
      .mockResolvedValue(work)
    const hook = setup(listWork)
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('error'))
    expect(hook.result.current.state.runtimeWork).toBeNull()
    expect(hook.result.current.state.runtimeWorkLoad.error).toBe('History busy')
    await act(async () => hook.result.current.refreshWorkLists())
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
    expect(hook.result.current.state.runtimeWorkLoad).toEqual({ phase: 'ready', error: null })
  })

  test('keeps the last task snapshot visible during refresh and failure', async () => {
    const pendingWork = deferred<RuntimeWorkListResponse>()
    const listWork = vi.fn().mockResolvedValueOnce(work).mockReturnValueOnce(pendingWork.promise)
    const hook = setup(listWork)
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    let refresh!: Promise<void>
    act(() => {
      refresh = hook.result.current.refreshWorkLists()
    })
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('refreshing')
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
    await act(async () => {
      pendingWork.reject(new Error('Request timed out'))
      await refresh
    })
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('error')
  })

  test('publishes refreshed task data before an unrelated device refresh settles', async () => {
    const pendingDevices = deferred<DeviceInfo[]>()
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce(devices)
      .mockReturnValueOnce(pendingDevices.promise)
    const listWork = vi
      .fn()
      .mockResolvedValueOnce(work)
      .mockResolvedValueOnce({ projects: [], chats: [], totalTasks: 0 })
    const hook = setup(listWork, listDevices)
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    let refresh!: Promise<void>
    act(() => {
      refresh = hook.result.current.refreshWorkLists()
    })
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(0))
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
    await act(async () => {
      pendingDevices.resolve(devices)
      await refresh
    })
  })

  test('ignores an older task response after a newer refresh succeeds', async () => {
    const oldWork = deferred<RuntimeWorkListResponse>()
    const listWork = vi
      .fn()
      .mockReturnValueOnce(oldWork.promise)
      .mockResolvedValueOnce({ projects: [], chats: [], totalTasks: 0 })
    const hook = setup(listWork)
    await act(async () => hook.result.current.refreshWorkLists())
    await act(async () => oldWork.resolve(work))
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(0)
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
  })

  test('does not reload shared navigation for a same-account profile or preference update', async () => {
    const hook = setup()
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    hook.rerender({
      user: { ...LOCAL_USER, user_name: 'Updated profile' },
      client: hook.executorClient,
    })
    expect(hook.listRuntimeWork).toHaveBeenCalledOnce()
    expect(hook.listDevices).toHaveBeenCalledOnce()
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
  })

  test('clears the previous runtime snapshot and rejects late responses after a scope change', async () => {
    const oldRefresh = deferred<RuntimeWorkListResponse>()
    const hook = setup(vi.fn().mockResolvedValueOnce(work).mockReturnValueOnce(oldRefresh.promise))
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    let refresh!: Promise<void>
    act(() => {
      refresh = hook.result.current.refreshWorkLists()
    })
    const nextWork = deferred<RuntimeWorkListResponse>()
    const nextClient = {
      runtime: { listRuntimeWork: vi.fn().mockReturnValue(nextWork.promise) },
      commands: { listDevices: vi.fn().mockResolvedValue(devices) },
    } as unknown as ExecutorClient
    hook.rerender({ user: { ...LOCAL_USER, id: LOCAL_USER.id + 1 }, client: nextClient })
    expect(hook.result.current.state.runtimeWork).toBeNull()
    await act(async () => {
      oldRefresh.resolve(work)
      await refresh
    })
    expect(hook.result.current.state.runtimeWork).toBeNull()
    await act(async () => nextWork.resolve({ projects: [], chats: [], totalTasks: 0 }))
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(0)
  })
})
