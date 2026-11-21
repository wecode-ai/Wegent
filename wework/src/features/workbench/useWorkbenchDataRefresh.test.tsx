import { act, renderHook, waitFor } from '@testing-library/react'
import { useState, useSyncExternalStore } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ExecutorClient } from '@/api/executorAccess'
import { LOCAL_USER } from '@/api/local/localSession'
import type { DeviceInfo, RuntimeWorkListResponse, User } from '@/types/api'
import type { WorkbenchServices } from './workbenchServices'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { createWorkbenchSessionState } from './workbenchSessionState'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { readCachedDeviceList } from './workbenchCloudStatus'
import { qualifyLocalRuntimeWork } from '@/lib/local-runtime-sidebar-identity'
import { AmbiguousExecutorIdentityError } from '@/lib/workbench-device'
import { runtimeProjectUiId, standaloneRuntimeProjectKey } from '@/lib/runtime-project'
import { buildRuntimeTaskRoute, navigateTo, parseRuntimeTaskRoute } from '@/lib/navigation'
import * as refreshHelpers from './workbenchDataRefreshHelpers'
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
  ownershipKey?: string,
  canNavigate?: () => boolean
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
      const [stateSource] = useState(() =>
        createWorkbenchSessionState(
          user,
          new RuntimeTaskLifecycleStore('data-refresh-fixture'),
          false
        )
      )
      const { state } = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
      const dispatch = stateSource.dispatch
      const actions = useWorkbenchDataRefresh({
        user,
        ownershipKey,
        executorClient: client,
        services: workbenchServices,
        stateSource,
        canNavigate,
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

  test('refreshes Goal and settlement snapshots by address without reloading the catalog', async () => {
    const hook = setup()
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    const task = { ...work.chats[0].tasks[0], running: true, optimistic: true }
    const getTask = vi.fn().mockResolvedValue(task)
    hook.executorClient.runtime.getRuntimeTask = getTask
    hook.listRuntimeWork.mockClear()
    const address = { deviceId: 'local-device', taskId: 'task-1', workspacePath: '/workspace' }
    await act(async () => {
      for (let index = 0; index < 8; index++) {
        expect(await hook.result.current.refreshRuntimeTask(address)).toEqual({
          ...task,
          optimistic: false,
        })
      }
    })
    expect(getTask).toHaveBeenCalledTimes(8)
    expect(getTask).toHaveBeenLastCalledWith(address)
    expect(hook.listRuntimeWork).not.toHaveBeenCalled()
    getTask.mockResolvedValue(null)
    expect(await hook.result.current.refreshRuntimeTask(address)).toBeNull()
    expect(hook.listRuntimeWork).not.toHaveBeenCalled()
    getTask.mockRejectedValue(new Error('owner unavailable'))
    await expect(hook.result.current.refreshRuntimeTask(address)).rejects.toThrow(
      'owner unavailable'
    )
    expect(hook.listRuntimeWork).not.toHaveBeenCalled()
  })

  test('preserves newer title and supervisor events while a point snapshot is pending', async () => {
    const hook = setup()
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    const pending = deferred<RuntimeWorkListResponse['chats'][number]['tasks'][number]>()
    hook.executorClient.runtime.getRuntimeTask = vi.fn().mockReturnValue(pending.promise)
    const address = { deviceId: 'local-device', taskId: 'task-1', workspacePath: '/workspace' }
    let refresh!: ReturnType<typeof hook.result.current.refreshRuntimeTask>
    act(() => {
      refresh = hook.result.current.refreshRuntimeTask(address)
      hook.result.current.updateLocalRuntimeTaskTitle(address, 'New title')
      hook.result.current.updateLocalRuntimeTaskSupervisor(address, null)
    })
    await act(async () => {
      pending.resolve({
        ...work.chats[0].tasks[0],
        supervisor: {
          mode: 'auto',
          status: 'active',
          instructions: '',
          intervalSeconds: 30,
          suggestions: [],
        },
      })
      expect(await refresh).toMatchObject({
        title: 'New title',
        supervisor: null,
        optimistic: false,
      })
    })
  })

  test('keeps project sessions on their project-authorized read path', async () => {
    const hook = setup()
    await waitFor(() => expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready'))
    const getTask = vi.fn()
    hook.executorClient.runtime.getRuntimeTask = getTask
    hook.listRuntimeWork.mockClear()
    await act(async () => {
      await hook.result.current.refreshRuntimeTask({
        deviceId: 'local-device',
        taskId: 'task-1',
        projectSession: { projectId: 'project-1', issueId: 'issue-1' },
      })
    })
    expect(getTask).not.toHaveBeenCalled()
    expect(hook.listRuntimeWork).toHaveBeenCalledTimes(1)
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

  test('publishes the first inventory while a newer refresh is still pending', async () => {
    const initial = deferred<RuntimeWorkListResponse>()
    const refreshed = deferred<RuntimeWorkListResponse>()
    const hook = setup(
      vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise)
    )
    let refresh!: Promise<void>
    act(() => {
      refresh = hook.result.current.refreshWorkLists({ refreshDevices: false })
    })
    await act(async () => initial.resolve(work))
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1)
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('refreshing')

    await act(async () => {
      refreshed.resolve({ projects: [], chats: [], totalTasks: 0 })
      await refresh
    })
    expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(0)
    expect(hook.result.current.state.runtimeWorkLoad.phase).toBe('ready')
  })

  test.each(['remote', 'app'] as const)(
    'preserves %s devices during a local refresh until cloud inventory removes them',
    async deviceType => {
      const pendingDevices = deferred<DeviceInfo[]>()
      const remoteDevice: DeviceInfo = {
        ...devices[0],
        device_id: 'remote-device',
        device_type: deviceType,
        is_default: false,
        execution_target_id: 'remote-device',
        runtime_features: {
          schemaVersion: 4,
          remoteTaskAccess: { version: 1, enabled: true },
        },
      }
      const cloudApi = {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi
          .fn()
          .mockResolvedValueOnce([remoteDevice])
          .mockReturnValue(pendingDevices.promise),
        listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
      }
      const hook = setup(undefined, undefined, {
        cloudBackgroundApi: cloudApi,
      } as WorkbenchServices)
      await waitFor(() =>
        expect(hook.result.current.cloudWorkStatus.availability).toBe('available')
      )

      await act(async () => hook.result.current.refreshDevices())
      await waitFor(() => expect(cloudApi.listDevices).toHaveBeenCalledTimes(2))
      expect(hook.result.current.state.devices.map(device => device.device_id)).toContain(
        'remote-device'
      )

      await act(async () => pendingDevices.resolve([]))
      await waitFor(() =>
        expect(hook.result.current.state.devices.map(device => device.device_id)).not.toContain(
          'remote-device'
        )
      )
    }
  )

  test('retains fresh cloud device status while the task inventory is pending', async () => {
    const remoteDevice: DeviceInfo = {
      ...devices[0],
      device_id: 'remote-device',
      device_type: 'remote',
      execution_target_id: 'remote-device',
      is_default: false,
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1, enabled: true },
      },
    }
    const pendingWork = deferred<RuntimeWorkListResponse>()
    const pendingInventory = deferred<DeviceInfo[]>()
    const cloudApi = {
      listTeams: vi.fn().mockResolvedValue([]),
      listDevices: vi.fn().mockResolvedValue([remoteDevice]),
      listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
    }
    const hook = setup(undefined, undefined, { cloudBackgroundApi: cloudApi } as WorkbenchServices)
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))
    cloudApi.listDevices
      .mockResolvedValueOnce([{ ...remoteDevice, status: 'offline' }])
      .mockReturnValue(pendingInventory.promise)
    cloudApi.listRuntimeWork.mockReturnValue(pendingWork.promise)

    await act(async () => hook.result.current.refreshDevices())
    const remoteStatus = () =>
      hook.result.current.state.devices.find(device => device.device_id === 'remote-device')?.status
    await waitFor(() => expect(remoteStatus()).toBe('offline'))

    await act(async () => hook.result.current.refreshDevices())
    expect(remoteStatus()).toBe('offline')

    await act(async () => {
      pendingInventory.resolve([{ ...remoteDevice, status: 'offline' }])
      pendingWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))
    expect(remoteStatus()).toBe('offline')
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

  test('retains an independent same-path local project after removal and a cloud-only refresh', async () => {
    const localProject = {
      project: {
        id: 2,
        key: 'local-project',
        name: 'Local',
        source: 'local_project' as const,
        stateDeviceId: 'local-device',
      },
      deviceWorkspaces: [
        {
          deviceId: 'local-device',
          workspacePath: '/workspace/shared',
          available: true,
          mapped: true,
          tasks: [],
        },
      ],
      totalTasks: 0,
    }
    const remoteProject = {
      project: {
        id: 1,
        key: 'remote-project',
        name: 'Remote',
        source: 'remote_project' as const,
        stateDeviceId: 'local-device',
        sidebarStateKey: 'remote-sidebar',
      },
      deviceWorkspaces: [
        {
          deviceId: 'remote-device',
          remoteHostId: 'remote-device',
          workspacePath: '/workspace/shared',
          available: true,
          mapped: true,
          tasks: [],
        },
      ],
      totalTasks: 0,
    }
    const localWork = { projects: [localProject, remoteProject], chats: [], totalTasks: 0 }
    const emptyWork = { projects: [], chats: [], totalTasks: 0 }
    const pendingCloudRefresh = deferred<RuntimeWorkListResponse>()
    const cloudApi = {
      listTeams: vi.fn().mockResolvedValue([]),
      listDevices: vi
        .fn()
        .mockResolvedValue([
          { ...devices[0], id: 2, device_id: 'remote-device', device_type: 'remote' },
        ]),
      listRuntimeWork: vi.fn().mockResolvedValue(emptyWork),
    }
    const hook = setup(vi.fn().mockResolvedValue(localWork), undefined, {
      cloudBackgroundApi: cloudApi,
    } as unknown as WorkbenchServices)
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))
    expect(hook.result.current.state.runtimeWork?.projects).toHaveLength(2)

    act(() => {
      hook.result.current.markRuntimeProjectRemoved(1, {
        deviceId: 'remote-device',
        workspacePath: '/workspace/shared',
      })
    })
    cloudApi.listRuntimeWork.mockReturnValue(pendingCloudRefresh.promise)
    await act(async () => hook.result.current.refreshDevices())
    await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    const freshProject = {
      ...remoteProject,
      project: { ...remoteProject.project, id: 3, key: 'fresh-remote', sidebarStateKey: 'fresh' },
      deviceWorkspaces: [
        { ...remoteProject.deviceWorkspaces[0], workspacePath: '/workspace/fresh' },
      ],
    }
    await act(async () => pendingCloudRefresh.resolve({ ...emptyWork, projects: [freshProject] }))
    await waitFor(() =>
      expect(
        hook.result.current.state.runtimeWork?.projects.map(item => item.project.key).sort()
      ).toEqual(['fresh-remote', 'local-project'])
    )

    expect(
      hook.result.current.state.runtimeWork?.projects.find(
        item => item.project.key === 'local-project'
      )
    ).toMatchObject(localProject)
    expect(hook.listRuntimeWork).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  test('cancels initial cloud checks and removes native chat projections without catalog runtime metadata', async () => {
    const nativeWork = qualifyLocalRuntimeWork(
      {
        ...work,
        projects: [
          {
            project: {
              id: 1,
              key: 'native-project',
              name: 'Native',
              source: 'local_project',
              stateDeviceId: 'local-device',
            },
            deviceWorkspaces: work.chats,
            totalTasks: 1,
          },
        ],
      },
      { deviceId: 'local-device', runtimeInstanceId: 'native-runtime', provenance: 'local-ipc' }
    )
    const pendingCloudWork = deferred<RuntimeWorkListResponse>()
    const cloudApi = {
      listTeams: vi.fn().mockResolvedValue([]),
      listDevices: vi.fn().mockResolvedValue([]),
      listRuntimeWork: vi.fn().mockReturnValue(pendingCloudWork.promise),
    }
    const hook = setup(vi.fn().mockResolvedValue(nativeWork), undefined, {
      cloudBackgroundApi: cloudApi,
    } as unknown as WorkbenchServices)
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.projects).toHaveLength(1))
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('syncing'))
    act(() => {
      hook.result.current.markRuntimeProjectRemoved(1, {
        deviceId: 'local-device',
        workspacePath: '/workspace',
      })
    })
    expect(hook.result.current.cloudWorkStatus.availability).toBe('idle')
    expect(Object.values(hook.result.current.cloudWorkStatus.checks)).not.toContain('syncing')

    const emptyWork = { projects: [], chats: [], totalTasks: 0 }
    cloudApi.listRuntimeWork.mockResolvedValue(emptyWork)
    await act(async () => {
      pendingCloudWork.resolve(nativeWork)
      await hook.result.current.refreshDevices()
    })
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('empty'))
    expect(hook.result.current.state.runtimeWork).toMatchObject(emptyWork)
    expect(hook.listRuntimeWork).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  test.each(['cloud', 'visible'] as const)(
    'keeps the active cloud request and all snapshots when the %s removal projection rejects',
    async projectionStage => {
      const remoteProject = {
        project: {
          id: 7,
          key: 'remote-project',
          name: 'Remote',
          source: 'remote_project' as const,
          stateDeviceId: 'local-device',
          sidebarStateKey: 'remote-sidebar',
        },
        deviceWorkspaces: [
          {
            deviceId: 'remote-device',
            remoteHostId: 'remote-device',
            workspacePath: '/remote',
            available: true,
            mapped: true,
            tasks: [],
          },
        ],
        totalTasks: 0,
      }
      const initialWork = { projects: [remoteProject], chats: [], totalTasks: 0 }
      const pendingCloudWork = deferred<RuntimeWorkListResponse>()
      let cloudSignal: AbortSignal | undefined
      const cloudApi = {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi
          .fn()
          .mockResolvedValue([
            { ...devices[0], id: 2, device_id: 'remote-device', device_type: 'remote' },
          ]),
        listRuntimeWork: vi.fn().mockResolvedValue(initialWork),
      }
      const hook = setup(
        vi.fn().mockResolvedValue({ ...work, projects: [remoteProject] }),
        undefined,
        {
          cloudBackgroundApi: cloudApi,
        } as unknown as WorkbenchServices
      )
      const cacheScope = workbenchCacheScope('', LOCAL_USER.id)
      await waitFor(() =>
        expect(hook.result.current.cloudWorkStatus.availability).toBe('available')
      )
      cloudApi.listRuntimeWork.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
        cloudSignal = signal
        return pendingCloudWork.promise
      })
      await act(async () => hook.result.current.refreshDevices())
      await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(2))
      const beforeWork = hook.result.current.state.runtimeWork
      const beforeCache = readCachedRemoteRuntimeWork(cacheScope)
      const beforeStatus = hook.result.current.cloudWorkStatus
      const rejection = new AmbiguousExecutorIdentityError('remote-device', [])
      const removeRuntimeProject = refreshHelpers.removeRuntimeProject
      const projection =
        projectionStage === 'cloud'
          ? vi
              .spyOn(refreshHelpers, 'removeRuntimeProjectFromCloudState')
              .mockImplementationOnce(() => {
                throw rejection
              })
          : vi
              .spyOn(refreshHelpers, 'removeRuntimeProject')
              .mockImplementation((snapshot, ...args) => {
                if (snapshot === beforeWork) throw rejection
                return removeRuntimeProject(snapshot, ...args)
              })
      try {
        expect(() =>
          hook.result.current.markRuntimeProjectRemoved(7, {
            deviceId: 'remote-device',
            workspacePath: '/remote',
          })
        ).toThrow(rejection)
        expect(cloudSignal?.aborted).toBe(false)
        expect(readCachedRemoteRuntimeWork(cacheScope)).toEqual(beforeCache)
        expect(hook.result.current.state.runtimeWork).toBe(beforeWork)
        expect(hook.result.current.getRuntimeWorkSnapshot()).toBe(beforeWork)
        expect(hook.result.current.cloudWorkStatus).toBe(beforeStatus)
      } finally {
        projection.mockRestore()
      }
      const freshProject = {
        ...remoteProject,
        project: {
          ...remoteProject.project,
          id: 8,
          key: 'fresh-project',
          sidebarStateKey: 'fresh-sidebar',
        },
        deviceWorkspaces: [{ ...remoteProject.deviceWorkspaces[0], workspacePath: '/fresh' }],
      }
      await act(async () =>
        pendingCloudWork.resolve({ projects: [freshProject], chats: [], totalTasks: 0 })
      )
      await waitFor(() =>
        expect(
          hook.result.current.state.runtimeWork?.projects.map(item => item.project.key).sort()
        ).toEqual(['fresh-project', 'remote-project'])
      )
      expect(hook.result.current.state.runtimeWork?.chats[0].tasks[0].taskId).toBe('task-1')
      expect(hook.listRuntimeWork).toHaveBeenCalledTimes(1)
      expect(cloudSignal?.aborted).toBe(true)
      hook.unmount()
    }
  )

  test.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    'publishes removed listed=%s workspace projections while preserving same-batch optimistic=%s tasks',
    async (listed, optimistic) => {
      const independentWorkspace = {
        ...work.chats[0],
        deviceId: 'independent-device',
        tasks: [{ ...work.chats[0].tasks[0], taskId: 'independent-task' }],
      }
      const independentProject = {
        project: {
          id: 2,
          key: 'independent',
          name: 'Independent',
          source: 'local_project' as const,
          stateDeviceId: 'independent-device',
        },
        deviceWorkspaces: [independentWorkspace],
        totalTasks: 1,
      }
      const nativeProject = {
        project: {
          id: 1,
          key: 'native',
          name: 'Native',
          source: 'local_project' as const,
          stateDeviceId: 'local-device',
        },
        deviceWorkspaces: work.chats,
        totalTasks: 1,
      }
      const directory = {
        ...nativeProject,
        project: {
          ...nativeProject.project,
          id: 3,
          key: 'old-directory',
          source: 'legacy_root' as const,
        },
      }
      const nativeWork = qualifyLocalRuntimeWork(
        {
          projects: [...(listed ? [nativeProject] : []), directory, independentProject],
          chats: work.chats,
          totalTasks: listed ? 4 : 3,
        },
        { deviceId: 'local-device', runtimeInstanceId: 'native-runtime', provenance: 'local-ipc' }
      )
      const hook = setup(
        vi.fn().mockResolvedValue(nativeWork),
        vi.fn().mockResolvedValue([
          { ...devices[0], runtime_instance_id: 'native-runtime' },
          {
            ...devices[0],
            id: 2,
            device_id: 'independent-device',
            runtime_instance_id: 'independent-runtime',
            device_type: 'remote',
          },
        ])
      )
      await waitFor(() => expect(hook.result.current.state.runtimeWork?.chats).toHaveLength(1))
      await waitFor(() => expect(hook.result.current.state.devices).toHaveLength(2))
      const projectId = listed
        ? 1
        : runtimeProjectUiId({
            key: standaloneRuntimeProjectKey('/workspace'),
            stateDeviceId: 'local-device',
            name: '/workspace',
          })
      act(() =>
        hook.result.current.dispatch({
          type: 'project_cleared',
          standaloneDeviceId: 'local-device',
          standaloneWorkspacePath: '/workspace',
        })
      )
      if (!listed)
        act(() =>
          hook.result.current.dispatch({
            type: 'runtime_task_opened',
            project: null,
            address: {
              deviceId: 'local-device',
              workspacePath: '/workspace',
              taskId: 'task-1',
            },
          })
        )
      act(() => {
        if (optimistic)
          hook.result.current.dispatch({
            type: 'runtime_task_optimistic_upserted',
            project: { id: 2, name: 'Independent', tasks: [] },
            workspace: independentWorkspace,
            task: {
              ...independentWorkspace.tasks[0],
              taskId: 'independent-new-task',
              optimistic: true,
            },
          })
        hook.result.current.markRuntimeProjectRemoved(projectId, {
          deviceId: 'local-device',
          workspacePath: '/workspace',
        })
        if (!listed)
          hook.result.current.dispatch({
            type: 'project_cleared',
            standaloneWorkspacePath: null,
            startFreshChat: true,
          })
      })
      expect(hook.result.current.state.runtimeWork?.projects.map(item => item.project.id)).toEqual([
        2,
      ])
      expect(hook.result.current.state.runtimeWork?.chats).toEqual([])
      expect(hook.result.current.state.currentRuntimeTask).toBeNull()
      expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(optimistic ? 2 : 1)
      expect(
        hook.result.current.state.runtimeWork?.projects[0].deviceWorkspaces[0].tasks.map(
          task => task.taskId
        )
      ).toEqual(optimistic ? ['independent-new-task', 'independent-task'] : ['independent-task'])
      expect(hook.result.current.getRuntimeWorkSnapshot()).toMatchObject({
        projects: [{ project: { id: 2 } }],
        chats: [],
        totalTasks: optimistic ? 2 : 1,
      })
      expect(hook.listRuntimeWork).toHaveBeenCalledTimes(1)
      expect(hook.listDevices).toHaveBeenCalledTimes(1)
      hook.unmount()
    }
  )

  test.each(['removed-task', 'new-selection', 'inactive-tab'] as const)(
    'navigates after removal only while the active route still belongs to the removed task: %s',
    async scenario => {
      const removedAddress = {
        deviceId: 'local-device',
        workspacePath: '/workspace',
        taskId: 'task-1',
      }
      const independentAddress = {
        deviceId: 'local-device',
        workspacePath: '/independent',
        taskId: 'independent-task',
      }
      const removedProject = { id: 7, key: 'removed', name: 'Removed', tasks: [] }
      const independentProject = { id: 8, key: 'independent', name: 'Independent', tasks: [] }
      const initialWork = {
        projects: [
          { project: removedProject, deviceWorkspaces: work.chats },
          {
            project: independentProject,
            deviceWorkspaces: [
              {
                ...work.chats[0],
                workspacePath: '/independent',
                tasks: [{ ...work.chats[0].tasks[0], ...independentAddress }],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      }
      const hook = setup(
        vi.fn().mockResolvedValue(initialWork),
        undefined,
        undefined,
        undefined,
        () => scenario !== 'inactive-tab'
      )
      const previousLocation = `${window.location.pathname}${window.location.search}`
      try {
        await waitFor(() => expect(hook.result.current.state.runtimeWork?.projects).toHaveLength(2))
        act(() => {
          hook.result.current.dispatch({
            type: 'runtime_task_opened',
            project: removedProject,
            address: removedAddress,
          })
          navigateTo(buildRuntimeTaskRoute(removedAddress))
        })
        act(() => {
          if (scenario === 'new-selection') {
            hook.result.current.dispatch({
              type: 'runtime_task_opened',
              project: independentProject,
              address: independentAddress,
            })
            navigateTo(buildRuntimeTaskRoute(independentAddress))
          }
          hook.result.current.markRuntimeProjectRemoved(7, removedAddress)
        })
        expect(hook.result.current.state.currentProject?.id ?? null).toBe(
          scenario === 'new-selection' ? 8 : null
        )
        expect(hook.result.current.state.currentRuntimeTask).toEqual(
          scenario === 'new-selection' ? independentAddress : null
        )
        const route = parseRuntimeTaskRoute(window.location.pathname, window.location.search)
        expect(route?.taskId ?? null).toBe(
          scenario === 'new-selection'
            ? 'independent-task'
            : scenario === 'inactive-tab'
              ? 'task-1'
              : null
        )
        expect(hook.listRuntimeWork).toHaveBeenCalledTimes(1)
      } finally {
        hook.unmount()
        window.history.replaceState({}, '', previousLocation)
      }
    }
  )

  test('uses one committed snapshot when removal runs before passive runtime-work synchronization', async () => {
    const removedProject = { id: 7, key: 'removed', name: 'Removed', tasks: [] }
    const independentProject = { id: 8, key: 'independent', name: 'Independent', tasks: [] }
    const independentAddress = {
      deviceId: 'local-device',
      workspacePath: '/independent',
      taskId: 'independent-task',
    }
    const initialWork = {
      projects: [{ project: removedProject, deviceWorkspaces: work.chats }],
      chats: [],
      totalTasks: 1,
    }
    const nextWork = {
      ...initialWork,
      projects: [
        ...initialWork.projects,
        {
          project: independentProject,
          deviceWorkspaces: [
            {
              ...work.chats[0],
              workspacePath: '/independent',
              tasks: [{ ...work.chats[0].tasks[0], ...independentAddress }],
            },
          ],
        },
      ],
      totalTasks: 2,
    }
    const listRuntimeWork = vi.fn().mockResolvedValue(initialWork)
    const executorClient = {
      runtime: { listRuntimeWork },
      commands: { listDevices: vi.fn().mockResolvedValue(devices) },
    } as unknown as ExecutorClient
    const previousLocation = `${window.location.pathname}${window.location.search}`
    let removed = false
    const hook = renderHook(() => {
      const [stateSource] = useState(() =>
        createWorkbenchSessionState(
          LOCAL_USER,
          new RuntimeTaskLifecycleStore('project-removal-fixture'),
          false
        )
      )
      const { state } = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
      const actions = useWorkbenchDataRefresh({
        user: LOCAL_USER,
        executorClient,
        services,
        stateSource,
      })
      const dispatch: typeof stateSource.dispatch = action => {
        stateSource.dispatch(action)
        if (!removed && stateSource.getSnapshot().state.currentProject?.id === 8) {
          removed = true
          actions.markRuntimeProjectRemoved(7, {
            deviceId: 'local-device',
            workspacePath: '/workspace',
          })
        }
      }
      return { state, dispatch, ...actions }
    })
    try {
      await waitFor(() => expect(hook.result.current.state.runtimeWork?.projects).toHaveLength(1))
      act(() => {
        hook.result.current.dispatch({ type: 'runtime_work_refreshed', runtimeWork: nextWork })
        hook.result.current.dispatch({
          type: 'runtime_task_opened',
          project: independentProject,
          address: independentAddress,
        })
        navigateTo(buildRuntimeTaskRoute(independentAddress))
      })
      expect(hook.result.current.state.runtimeWork?.projects.map(item => item.project.id)).toEqual([
        8,
      ])
      expect(hook.result.current.state.currentProject?.id).toBe(8)
      expect(hook.result.current.state.currentRuntimeTask).toEqual(independentAddress)
      expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)?.taskId).toBe(
        'independent-task'
      )
      expect(
        hook.result.current.getRuntimeWorkSnapshot()?.projects.map(item => item.project.id)
      ).toEqual([8])
      expect(listRuntimeWork).toHaveBeenCalledTimes(1)
    } finally {
      hook.unmount()
      window.history.replaceState({}, '', previousLocation)
    }
  })

  test('completes initial cloud inventory after a work event supersedes bootstrap work', async () => {
    const pendingDevices = deferred<DeviceInfo[]>()
    const remoteDevice = {
      ...devices[0],
      device_id: 'remote-device',
      device_type: 'remote' as const,
    }
    const cloudApi = {
      listTeams: vi.fn().mockResolvedValue([]),
      listDevices: vi.fn().mockResolvedValue([remoteDevice]),
      listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
    }
    const hook = setup(undefined, vi.fn().mockReturnValue(pendingDevices.promise), {
      cloudBackgroundApi: cloudApi,
    } as WorkbenchServices)
    await waitFor(() => expect(hook.result.current.state.runtimeWork?.totalTasks).toBe(1))
    await act(async () => hook.result.current.refreshWorkLists({ refreshDevices: false }))
    await act(async () => pendingDevices.resolve(devices))

    await waitFor(() => expect(cloudApi.listDevices).toHaveBeenCalledOnce())
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))
    expect(cloudApi.listTeams).toHaveBeenCalledOnce()
    expect(hook.listDevices).toHaveBeenCalledOnce()
    expect(
      hook.result.current.state.devices.some(device => device.device_id === 'remote-device')
    ).toBe(true)
  })

  test('preserves pending cloud inventory and follows it with the latest work-only refresh', async () => {
    const pendingDevices = deferred<DeviceInfo[]>()
    const pendingTeams = deferred<never[]>()
    const pendingWork = deferred<RuntimeWorkListResponse>()
    const remoteDevice = {
      ...devices[0],
      device_id: 'remote-device',
      device_type: 'remote' as const,
    }
    const cloudApi = {
      listTeams: vi.fn().mockReturnValue(pendingTeams.promise),
      listDevices: vi.fn().mockReturnValue(pendingDevices.promise),
      listRuntimeWork: vi
        .fn()
        .mockReturnValueOnce(pendingWork.promise)
        .mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
    }
    const hook = setup(undefined, undefined, { cloudBackgroundApi: cloudApi } as WorkbenchServices)
    await waitFor(() => expect(cloudApi.listDevices).toHaveBeenCalledOnce())
    const signal = cloudApi.listDevices.mock.calls[0]?.[0]?.signal as AbortSignal

    await act(async () => hook.result.current.refreshWorkLists({ refreshDevices: false }))
    await act(async () => hook.result.current.refreshWorkLists({ refreshDevices: false }))
    const inventoryAborted = signal.aborted
    const workCallsBeforeInventory = cloudApi.listRuntimeWork.mock.calls.length
    await act(async () => {
      pendingDevices.resolve([remoteDevice])
      pendingTeams.resolve([])
      pendingWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })

    expect(inventoryAborted).toBe(false)
    expect(workCallsBeforeInventory).toBe(1)
    await waitFor(() => expect(cloudApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hook.result.current.cloudWorkStatus.availability).toBe('available'))
    expect(cloudApi.listDevices).toHaveBeenCalledOnce()
    expect(cloudApi.listTeams).toHaveBeenCalledOnce()
    expect(
      hook.result.current.state.devices.some(device => device.device_id === 'remote-device')
    ).toBe(true)
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
