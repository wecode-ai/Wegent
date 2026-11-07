import { act, renderHook, waitFor } from '@testing-library/react'
import { useReducer } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ExecutorClient } from '@/api/executorAccess'
import { LOCAL_USER } from '@/api/local/localSession'
import type { DeviceInfo, RuntimeWorkListResponse, User } from '@/types/api'
import type { WorkbenchServices } from './workbenchServices'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { readCachedDeviceList } from './workbenchCloudStatus'
import {
  readCachedRemoteRuntimeWork,
  writeCachedRemoteRuntimeWork,
  workbenchCacheScope,
} from './remoteRuntimeWorkCache'

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
  listDevices = vi.fn().mockResolvedValue(devices),
  workbenchServices = services,
  ownershipKey?: string
) {
  const executorClient = {
    runtime: { listRuntimeWork },
    commands: { listDevices },
  } as unknown as ExecutorClient
  const hook = renderHook(
    ({
      user,
      client,
      ownershipKey,
    }: {
      user: User
      client: ExecutorClient
      ownershipKey?: string
    }) => {
      const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
      const actions = useWorkbenchDataRefresh({
        user,
        ownershipKey,
        executorClient: client,
        services: workbenchServices,
        state,
        dispatch,
      })
      return { state, dispatch, ...actions }
    },
    {
      initialProps: { user: LOCAL_USER, client: executorClient, ownershipKey } as {
        user: User
        client: ExecutorClient
        ownershipKey?: string
      },
    }
  )
  return { ...hook, executorClient, listRuntimeWork, listDevices }
}

describe('useWorkbenchDataRefresh', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  test('refreshes changed work without rediscovering unchanged devices', async () => {
    const hook = setup()
    await waitFor(() => expect(hook.result.current.state.devices).toHaveLength(1))
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    hook.listRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })

    await act(async () => hook.result.current.refreshWorkLists({ refreshDevices: false }))

    expect(hook.listDevices).toHaveBeenCalledOnce()
    expect(hook.listRuntimeWork).toHaveBeenCalledTimes(2)
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(0)
    expect(hook.result.current.state.devices).toEqual(devices)
    await act(async () => hook.result.current.refreshWorkLists())
    expect(hook.listDevices).toHaveBeenCalledTimes(2)
  })

  test('does not invalidate pending bootstrap discovery during a work-only refresh', async () => {
    const pendingDevices = deferred<DeviceInfo[]>()
    const hook = setup(undefined, vi.fn().mockReturnValue(pendingDevices.promise))
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    let refresh!: Promise<void>
    act(() => {
      refresh = hook.result.current.refreshWorkLists({ refreshDevices: false })
    })
    await act(async () => {
      pendingDevices.resolve(devices)
      await refresh
    })
    expect(hook.listDevices).toHaveBeenCalledOnce()
    expect(hook.result.current.state.devices).toEqual(devices)
    expect(hook.result.current.state.isBootstrapping).toBe(false)
  })

  test('keeps cloud navigation while refreshing only the changed work inventory', async () => {
    const cloudDevice = {
      ...devices[0],
      device_id: 'remote-device',
      device_type: 'remote' as const,
      app_device_id: null,
      socket_device_id: null,
      runtime_instance_id: null,
    }
    const cloudApi = {
      listTeams: vi.fn().mockResolvedValue([]),
      listDevices: vi.fn().mockResolvedValue([cloudDevice]),
      listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
    }
    const hook = setup(undefined, undefined, { cloudBackgroundApi: cloudApi } as WorkbenchServices)
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))
    const initialDevices = hook.result.current.state.devices
    expect(initialDevices.some(device => device.device_id === 'remote-device')).toBe(true)

    await act(async () => hook.result.current.refreshWorkLists({ refreshDevices: false }))
    await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(2))

    expect(hook.listDevices).toHaveBeenCalledOnce()
    expect(cloudApi.listDevices).toHaveBeenCalledOnce()
    expect(cloudApi.listTeams).toHaveBeenCalledOnce()
    expect(hook.result.current.state.devices).toEqual(initialDevices)
  })

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

  test('preserves same-owner navigation across transport replacement and rejects its old responses', async () => {
    const oldWork = deferred<RuntimeWorkListResponse>()
    const hook = setup(vi.fn().mockResolvedValueOnce(work).mockReturnValueOnce(oldWork.promise))
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    const address = { deviceId: 'local-device', taskId: 'task-1', workspacePath: '/workspace' }
    act(() => hook.result.current.dispatch({ type: 'runtime_task_opened', address, project: null }))
    let oldRefresh!: Promise<void>
    act(() => {
      oldRefresh = hook.result.current.refreshWorkLists()
    })
    const nextWork = deferred<RuntimeWorkListResponse>()
    const nextDevices = deferred<DeviceInfo[]>()
    const nextClient = {
      runtime: { listRuntimeWork: vi.fn().mockReturnValue(nextWork.promise) },
      commands: { listDevices: vi.fn().mockReturnValue(nextDevices.promise) },
    } as unknown as ExecutorClient
    hook.rerender({ user: LOCAL_USER, client: nextClient })
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
    expect(hook.result.current.state.currentRuntimeTask).toEqual(address)
    expect(hook.result.current.state.isBootstrapping).toBe(false)
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('refreshing')
    await act(async () => {
      oldWork.resolve({ projects: [], chats: [], totalTasks: 0 })
      await oldRefresh
    })
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
    await act(async () => {
      nextDevices.resolve(devices)
      nextWork.resolve(work)
    })
    expect(hook.result.current.state.currentRuntimeTask).toEqual(address)
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
  })

  test('clears a previous backend snapshot even when the user ID and client are unchanged', async () => {
    const nextWork = deferred<RuntimeWorkListResponse>()
    const hook = setup(vi.fn().mockResolvedValueOnce(work).mockReturnValueOnce(nextWork.promise))
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    hook.rerender({ user: LOCAL_USER, client: hook.executorClient, ownershipKey: 'backend-b' })
    expect(hook.result.current.state.runtimeWork).toBeNull()
    expect(hook.result.current.state.currentRuntimeTask).toBeNull()
    await act(async () => nextWork.resolve({ projects: [], chats: [], totalTasks: 0 }))
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
  })

  test('isolates cached and live cloud snapshots across backends with the same user ID', async () => {
    const ownerA = JSON.stringify(['https://backend-a.example/api', LOCAL_USER.id])
    const ownerB = JSON.stringify(['https://backend-b.example/api', LOCAL_USER.id])
    const remoteDevice = (id: string): DeviceInfo => ({
      ...devices[0],
      device_id: id,
      device_type: 'remote',
      bind_shell: 'claudecode',
      is_default: false,
    })
    const remoteWork = (id: string): RuntimeWorkListResponse => ({
      projects: [],
      chats: [
        { ...work.chats[0], deviceId: id, tasks: [{ ...work.chats[0].tasks[0], taskId: id }] },
      ],
      totalTasks: 1,
    })
    const workA = remoteWork('remote-a')
    const workB = remoteWork('remote-b')
    writeCachedRemoteRuntimeWork(workbenchCacheScope(ownerA, LOCAL_USER.id), workA, [
      remoteDevice('remote-a'),
    ])
    const pendingLocalB = deferred<RuntimeWorkListResponse>()
    const pendingCloudB = deferred<RuntimeWorkListResponse>()
    const cloudApi = {
      listTeams: vi.fn().mockResolvedValue([]),
      listDevices: vi
        .fn()
        .mockResolvedValueOnce([remoteDevice('remote-a')])
        .mockResolvedValue([remoteDevice('remote-b')]),
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(workA)
        .mockReturnValueOnce(pendingCloudB.promise)
        .mockResolvedValueOnce(workB)
        .mockRejectedValue(new Error('Cloud unavailable')),
    }
    const hook = setup(
      vi
        .fn()
        .mockResolvedValueOnce(work)
        .mockReturnValueOnce(pendingLocalB.promise)
        .mockResolvedValue(work),
      undefined,
      { cloudBackgroundApi: cloudApi } as WorkbenchServices,
      ownerA
    )
    const taskIds = () =>
      hook.result.current.state.runtimeWork?.chats.flatMap(row =>
        row.tasks.map(task => task.taskId)
      )
    await waitFor(() => expect(taskIds()).toContain('remote-a'))
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))

    hook.rerender({ user: LOCAL_USER, client: hook.executorClient, ownershipKey: ownerB })
    expect(hook.result.current.state.runtimeWork).toBeNull()
    await act(async () => pendingLocalB.resolve(work))
    await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(taskIds()).toEqual(['task-1'])
    expect(hook.result.current.state.devices.some(device => device.device_id === 'remote-a')).toBe(
      false
    )
    await act(async () => pendingCloudB.reject(new Error('Backend B unavailable')))
    expect(taskIds()).not.toContain('remote-a')
    expect(
      readCachedRemoteRuntimeWork(workbenchCacheScope(ownerA, LOCAL_USER.id)).chats[0].tasks[0]
        .taskId
    ).toBe('remote-a')
    expect(readCachedRemoteRuntimeWork(workbenchCacheScope(ownerB, LOCAL_USER.id)).totalTasks).toBe(
      0
    )

    await act(async () => hook.result.current.refreshWorkLists())
    await waitFor(() => expect(taskIds()).toContain('remote-b'))
    const previousOwnerArchive = hook.result.current.markRuntimeTasksArchived
    hook.rerender({ user: LOCAL_USER, client: hook.executorClient, ownershipKey: ownerA })
    await waitFor(() => expect(taskIds()).toContain('remote-a'))
    expect(taskIds()).not.toContain('remote-b')
    act(() => previousOwnerArchive([{ deviceId: 'remote-b', taskId: 'remote-b' }]))
    expect(
      readCachedRemoteRuntimeWork(workbenchCacheScope(ownerA, LOCAL_USER.id)).chats[0].tasks[0]
        .taskId
    ).toBe('remote-a')
    expect(
      readCachedRemoteRuntimeWork(workbenchCacheScope(ownerB, LOCAL_USER.id)).chats[0].tasks[0]
        .taskId
    ).toBe('remote-b')
  })

  test('old cloud completion cannot abandon the new owner sync with the same revision', async () => {
    const previousCloud = deferred<RuntimeWorkListResponse>()
    const currentCloud = deferred<RuntimeWorkListResponse>()
    const cloudApi = {
      listRuntimeWork: vi
        .fn()
        .mockReturnValueOnce(previousCloud.promise)
        .mockReturnValueOnce(currentCloud.promise),
    }
    const hook = setup(
      undefined,
      undefined,
      { cloudBackgroundApi: cloudApi } as WorkbenchServices,
      'backend-a'
    )
    await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(1))
    hook.rerender({ user: LOCAL_USER, client: hook.executorClient, ownershipKey: 'backend-b' })
    await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(hook.result.current.cloudWorkStatus.availability).toBe('syncing')
    await act(async () => previousCloud.resolve({ projects: [], chats: [], totalTasks: 0 }))
    expect(hook.result.current.cloudWorkStatus.availability).toBe('syncing')
    await act(async () => currentCloud.resolve({ projects: [], chats: [], totalTasks: 0 }))
    expect(hook.result.current.cloudWorkStatus.availability).not.toBe('syncing')
  })

  test('keeps account caches separate when the backend ownership key stays unchanged', async () => {
    const ownershipKey = 'https://backend.example/api'
    const oldUser = LOCAL_USER
    const newUser = { ...LOCAL_USER, id: LOCAL_USER.id + 1 }
    const remote = {
      ...work,
      chats: [{ ...work.chats[0], deviceId: 'old-owner-remote' }],
    }
    writeCachedRemoteRuntimeWork(workbenchCacheScope(ownershipKey, oldUser.id), remote)
    const cloudApi = { listRuntimeWork: vi.fn().mockRejectedValue(new Error('Unavailable')) }
    const hook = setup(
      undefined,
      undefined,
      { cloudBackgroundApi: cloudApi } as WorkbenchServices,
      ownershipKey
    )
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(2))

    hook.rerender({ user: newUser, client: hook.executorClient, ownershipKey })
    expect(hook.result.current.state.runtimeWork).toBeNull()
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    expect(hook.result.current.state.runtimeWork?.chats.map(row => row.deviceId)).toEqual([
      'local-device',
    ])
    expect(
      readCachedRemoteRuntimeWork(workbenchCacheScope(ownershipKey, newUser.id)).totalTasks
    ).toBe(0)
    expect(
      readCachedRemoteRuntimeWork(workbenchCacheScope(ownershipKey, oldUser.id)).totalTasks
    ).toBe(1)
  })

  test('ignores stale device refreshes before they can overwrite the current owner cache', async () => {
    const oldDevices = deferred<DeviceInfo[]>()
    const hook = setup(
      undefined,
      vi.fn().mockResolvedValueOnce(devices).mockReturnValueOnce(oldDevices.promise)
    )
    await waitFor(() => expect(hook.result.current.state.devices).toHaveLength(1))
    let previousRefresh!: Promise<void>
    act(() => {
      previousRefresh = hook.result.current.refreshDevices()
    })
    const currentDevices = [{ ...devices[0], name: 'Current transport' }]
    const nextClient = {
      runtime: { listRuntimeWork: vi.fn().mockResolvedValue(work) },
      commands: { listDevices: vi.fn().mockResolvedValue(currentDevices) },
    } as unknown as ExecutorClient
    hook.rerender({ user: LOCAL_USER, client: nextClient })
    await waitFor(() => expect(hook.result.current.state.devices[0].name).toBe('Current transport'))
    await act(async () => {
      oldDevices.resolve([{ ...devices[0], name: 'Obsolete transport' }])
      await previousRefresh
    })
    expect(hook.result.current.state.devices[0].name).toBe('Current transport')
    expect(readCachedDeviceList(workbenchCacheScope('', LOCAL_USER.id))[0].name).toBe(
      'Current transport'
    )
  })
})
