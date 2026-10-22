import { updateRuntimeWorkProject } from '@/lib/runtime-project-update'
import { qualifyLocalRuntimeWork } from '@/lib/local-runtime-sidebar-identity'
import { mergeRuntimeWorkLists } from './runtimeWorkMerge'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import {
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectActivation,
  getRuntimeRemoteProjectRegistrations,
} from '@/lib/runtime-project-state'
import '@/i18n'
import { createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import { describe, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ExecutorClient } from '@/api/executorAccess'
import {
  isMatchingGitCheckout,
  normalizeGitRepositoryUrl,
  useWorkbenchProjectActions,
} from './useWorkbenchProjectActions'

type ExecuteCommand = ExecutorClient['commands']['executeCommand']

function commandResponse(stdout: string) {
  return {
    success: true,
    exit_code: 0,
    stdout,
    stderr: '',
  }
}

describe('Git project clone recovery', () => {
  test('normalizes optional Git suffixes', () => {
    expect(normalizeGitRepositoryUrl('https://github.com/owner/repo.git/')).toBe(
      'https://github.com/owner/repo'
    )
  })

  test('accepts an existing checkout of the requested repository and branch', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce(commandResponse('https://github.com/owner/repo.git\n'))
      .mockResolvedValueOnce(commandResponse('develop\n')) as unknown as ExecuteCommand

    await expect(
      isMatchingGitCheckout(
        executeCommand,
        'device-1',
        '/workspace/repo',
        'https://github.com/owner/repo.git',
        'develop'
      )
    ).resolves.toBe(true)
  })

  test('rejects an existing checkout of a different repository', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValue(
        commandResponse('https://github.com/other/repo.git\n')
      ) as unknown as ExecuteCommand

    await expect(
      isMatchingGitCheckout(
        executeCommand,
        'device-1',
        '/workspace/repo',
        'https://github.com/owner/repo.git'
      )
    ).resolves.toBe(false)
  })
})

describe('device project settings save', () => {
  const update = {
    deviceId: 'remote',
    projectKey: 'owner-key',
    name: 'Saved',
    roots: ['/new', '/extra'],
    defaultProjectSpace: { projectStore: 'backend', projectId: 'space' },
    aiSettings: { instructions: 'New instructions' },
  }
  function setup(
    syncAccepted = true,
    saveAccepted = true,
    queue?: (mutation: () => Promise<unknown>) => Promise<unknown>
  ) {
    const events: string[] = []
    const upsert = vi.fn(async (data: unknown) => {
      void data
      return { ...update, accepted: saveAccepted, error: saveAccepted ? null : 'Owner rejected' }
    })
    const sync = vi.fn(async () => {
      events.push('sync')
      return { accepted: syncAccepted, error: 'Mirror rejected' }
    })
    const updateRuntimeProject = vi.fn(saved => {
      events.push('projection')
      options.state.runtimeWork = updateRuntimeWorkProject(
        options.state.runtimeWork as never,
        saved
      ) as never
    })
    const refreshWorkLists = vi.fn(async () => events.push('refresh'))
    const options = {
      user: { id: 1 },
      state: {
        devices: [
          { id: 0, device_id: 'local', device_type: 'local', status: 'online' },
          {
            id: 1,
            device_id: 'remote',
            device_type: 'remote',
            status: 'online',
            executor_version: '1.8.6',
          },
        ],
        runtimeWork: {
          projects: [
            {
              project: {
                key: 'owner-key',
                ownerProjectKey: 'owner-key',
                ownerDeviceId: 'remote',
                sidebarStateKey: 'stable-sidebar',
                name: 'Old',
                source: 'remote_project',
                stateDeviceId: 'local',
              },
              deviceWorkspaces: [
                {
                  deviceId: 'remote',
                  remoteHostId: 'remote',
                  workspacePath: '/old',
                  tasks: [],
                  available: true,
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
        },
      },
      dispatch: vi.fn(),
      executorClient: {
        runtime: {
          upsertLocalRuntimeProject: upsert,
          syncRuntimeRemoteProjects: sync,
          listRuntimeWork: vi.fn(async () => {
            const persisted = (upsert.mock.calls.at(-1)?.[0] ?? update) as typeof update
            return {
              projects: [
                {
                  project: {
                    ...persisted,
                    key: update.projectKey,
                    source: 'local_project',
                    stateDeviceId: 'remote',
                    roots: persisted.roots.map(path => ({ kind: 'local', path })),
                  },
                  deviceWorkspaces: [],
                },
              ],
              chats: [],
              totalTasks: 0,
            }
          }),
          renameRuntimeWorkspace: vi.fn(async () => ({ accepted: true, deviceId: 'remote' })),
        },
      },
      services: {
        projectApi: {},
        getLocalRuntimeSidebarIdentity: vi.fn(async () => ({
          deviceId: options.state.devices[0].device_id,
          runtimeInstanceId: 'current-local-runtime',
          provenance: 'local-ipc' as const,
        })),
      },
      refreshWorkLists,
      updateRuntimeProject,
      updateLocalRuntimeTaskPinned: vi.fn(),
      rollbackLocalRuntimeTaskPinned: vi.fn(),
      markRuntimeProjectRemoved: vi.fn(),
      invalidateRemoteProjectSync: vi.fn(),
      clearRemoteProjectSyncRemoval: vi.fn(),
      enqueueRemoteProjectStateMutation:
        queue ?? (async (mutation: () => Promise<unknown>) => mutation()),
    }
    const getRuntimeWorkSnapshot = () => options.state.runtimeWork
    const getRemoteProjectRegistrations = (localSidebarIdentity?: {
      deviceId: string
      runtimeInstanceId: string
      provenance: 'local-ipc'
    }) =>
      getRuntimeRemoteProjectRegistrations(
        getRuntimeWorkSnapshot() as never,
        getLocalRuntimeStateDeviceId(options.state.devices as never),
        { devices: options.state.devices as never, localSidebarIdentity }
      )
    const { result, rerender } = renderHook(() =>
      useWorkbenchProjectActions({
        ...options,
        getRuntimeWorkSnapshot,
        getRemoteProjectRegistrations,
      } as never)
    )
    return {
      result,
      rerender,
      upsert,
      sync,
      updateRuntimeProject,
      refreshWorkLists,
      events,
      options,
    }
  }

  test('saves full metadata on owner before projecting and synchronizing the stable mirror', async () => {
    const { result, upsert, sync, events } = setup()
    await result.current.updateLocalRuntimeProject(update as never)
    expect(upsert).toHaveBeenCalledWith({ ...update, runtime: 'codex' })
    expect(events).toEqual(['projection', 'sync', 'refresh'])
    expect(sync).toHaveBeenCalledWith(
      {
        deviceId: 'local',
        projects: [
          {
            id: 'stable-sidebar',
            hostId: 'remote',
            projectKey: 'owner-key',
            label: 'Saved',
            remotePath: '/new',
            roots: ['/new', '/extra'],
            defaultProjectSpace: update.defaultProjectSpace,
            aiSettings: update.aiSettings,
          },
        ],
      },
      {
        localSidebarIdentity: {
          deviceId: 'local',
          runtimeInstanceId: 'current-local-runtime',
          provenance: 'local-ipc',
        },
      }
    )
  })

  test('retains the confirmed owner settings while surfacing a mirror sync failure', async () => {
    const { result, updateRuntimeProject, refreshWorkLists } = setup(false)
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow(
      'Mirror rejected'
    )
    expect(updateRuntimeProject).toHaveBeenCalledWith(update)
    expect(refreshWorkLists).not.toHaveBeenCalled()
  })

  test('saves the owner and full mirror when a different runtime shares the local Electron alias', async () => {
    const { result, options, sync, updateRuntimeProject } = setup()
    Object.assign(options.state.devices[0], {
      device_id: 'electron-shared',
      runtime_instance_id: 'current-local-runtime',
    })
    options.state.devices.push({
      device_id: 'history',
      device_type: 'remote',
      status: 'offline',
      app_device_id: 'electron-shared',
      runtime_instance_id: 'old-runtime',
    } as never)
    await expect(result.current.updateLocalRuntimeProject(update as never)).resolves.toBeUndefined()
    expect(updateRuntimeProject).toHaveBeenCalledWith(update)
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'electron-shared',
        projects: [expect.objectContaining({ id: 'stable-sidebar', roots: ['/new', '/extra'] })],
      }),
      {
        localSidebarIdentity: {
          deviceId: 'electron-shared',
          runtimeInstanceId: 'current-local-runtime',
          provenance: 'local-ipc',
        },
      }
    )
  })

  test('keeps native local projects and chats during the real merged refresh after remote settings save', async () => {
    const { result, options, sync, refreshWorkLists } = setup()
    Object.assign(options.state.devices[0], {
      device_id: 'electron-shared',
      runtime_instance_id: 'current-local-runtime',
    })
    options.state.devices.push({
      device_id: 'history',
      device_type: 'remote',
      status: 'offline',
      app_device_id: 'electron-shared',
      runtime_instance_id: 'old-runtime',
    } as never)
    const nativeWorkspace = {
      deviceId: 'electron-shared',
      workspacePath: '/repo/local',
      workspaceSource: 'local',
      mapped: true,
      available: true,
      tasks: [
        {
          taskId: 'local-task',
          workspacePath: '/repo/local',
          title: 'Keep task',
          runtime: 'codex',
        },
      ],
    }
    options.state.runtimeWork.projects[0].project.stateDeviceId = 'electron-shared'
    Object.assign(options.state.runtimeWork.projects[0].deviceWorkspaces[0], { mapped: true })
    const identity = {
      deviceId: 'electron-shared',
      runtimeInstanceId: 'current-local-runtime',
      provenance: 'local-ipc' as const,
    }
    options.state.runtimeWork = qualifyLocalRuntimeWork(
      options.state.runtimeWork as never,
      identity
    ) as never
    const local = {
      projects: [
        {
          project: {
            key: 'native-local-key',
            name: 'Keep local',
            stateDeviceId: 'electron-shared',
            source: 'local_project',
            pinned: true,
            sidebarOrder: 2,
            appearance: { color: 'pink' },
          },
          deviceWorkspaces: [nativeWorkspace],
        },
      ],
      chats: [
        {
          ...nativeWorkspace,
          workspacePath: '/repo/chat',
          tasks: [{ ...nativeWorkspace.tasks[0], taskId: 'local-chat' }],
        },
      ],
      totalTasks: 2,
    }
    refreshWorkLists.mockImplementation(async () => {
      const trusted = qualifyLocalRuntimeWork(local as never, {
        deviceId: 'electron-shared',
        runtimeInstanceId: 'current-local-runtime',
        provenance: 'local-ipc',
      })
      options.state.runtimeWork = mergeRuntimeWorkLists(
        trusted,
        options.state.runtimeWork as never,
        {
          devices: options.state.devices as never,
        }
      ) as never
      const remote = options.state.runtimeWork.projects.find(item => item.project.name === 'Saved')!
      expect(
        getRuntimeProjectActivation(
          options.state.runtimeWork as never,
          runtimeProjectUiId(remote.project as never),
          identity.deviceId,
          options.state.devices as never,
          identity
        )
      ).toEqual({
        deviceId: identity.deviceId,
        projectKey: 'stable-sidebar',
        workspacePath: '/new',
        remoteHostId: 'remote',
      })
    })
    await expect(result.current.updateLocalRuntimeProject(update as never)).resolves.toBeUndefined()
    expect(sync).toHaveBeenCalled()
    expect(options.state.runtimeWork.projects).toContainEqual(
      expect.objectContaining({
        project: expect.objectContaining({
          key: 'native-local-key',
          pinned: true,
          sidebarOrder: 2,
          appearance: { color: 'pink' },
        }),
        deviceWorkspaces: [
          expect.objectContaining({ tasks: [expect.objectContaining({ taskId: 'local-task' })] }),
        ],
      })
    )
    expect(
      (options.state.runtimeWork as unknown as { chats: typeof local.chats }).chats[0].tasks[0]
        .taskId
    ).toBe('local-chat')
    expect(JSON.stringify(options.state.runtimeWork)).not.toContain('current-local-runtime')
  })

  test('preserves the confirmed owner save and rejects a queued mirror after local runtime replacement', async () => {
    const queued: Array<() => Promise<void>> = []
    const { result, options, sync, updateRuntimeProject } = setup(
      true,
      true,
      mutation =>
        new Promise((resolve, reject) =>
          queued.push(async () => {
            try {
              resolve(await mutation())
            } catch (error) {
              reject(error)
            }
          })
        )
    )
    const saving = result.current.updateLocalRuntimeProject(update as never)
    const rejected = expect(saving).rejects.toThrow('local-sidebar-runtime-changed')
    await waitFor(() => expect(queued).toHaveLength(1))
    options.services.getLocalRuntimeSidebarIdentity.mockResolvedValue({
      deviceId: 'local',
      runtimeInstanceId: 'replacement',
      provenance: 'local-ipc',
    })
    await queued[0]()
    await rejected
    expect(updateRuntimeProject).toHaveBeenCalledWith(update)
    expect(sync).not.toHaveBeenCalled()
  })

  test('does not project settings or sync when the owner rejects the save', async () => {
    const { result, updateRuntimeProject, sync } = setup(true, false)
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow(
      'Owner rejected'
    )
    expect(updateRuntimeProject).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  test('rejects an accepted save with a dropped supported AI field before projecting', async () => {
    const { result, upsert, updateRuntimeProject, sync } = setup()
    upsert.mockImplementation(
      async () => ({ ...update, aiSettings: undefined, accepted: true, error: null }) as never
    )
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow()
    expect(updateRuntimeProject).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  test.each([
    ['aiSettings', { instructions: '' }],
    ['aiSettings', null],
    ['defaultProjectSpace', null],
  ])(
    'rejects an omitted requested echo field %s even for a clear or empty value',
    async (field, value) => {
      const { result, upsert, updateRuntimeProject } = setup()
      upsert.mockImplementation(async data => {
        const response = { ...(data as typeof update), accepted: true, error: null } as Record<
          string,
          unknown
        >
        delete response[field as string]
        return response as never
      })
      await expect(
        result.current.updateLocalRuntimeProject({ ...update, [field as string]: value } as never)
      ).rejects.toThrow()
      expect(updateRuntimeProject).not.toHaveBeenCalled()
    }
  )

  test('does not infer supported single-root readback through the real IPC response adapter', async () => {
    const { result, options, upsert, updateRuntimeProject } = setup()
    const desired = { ...update, roots: ['/new'] }
    upsert.mockImplementation(async data => ({
      ...(data as typeof update),
      accepted: true,
      error: null,
    }))
    const ownerApi = createRuntimeWorkApiFromIpc(
      async () => ({
        workspaces: [
          {
            workspacePath: '/new',
            projectKey: 'owner-key',
            label: update.name,
            projectSource: 'local_project',
            projectAiSettings: update.aiSettings,
            defaultProjectSpace: update.defaultProjectSpace,
            tasks: [],
          },
        ],
      }),
      async () => 'remote'
    )
    options.executorClient.runtime.listRuntimeWork.mockImplementation(requestOptions =>
      ownerApi.listRuntimeWork(requestOptions)
    )
    await expect(result.current.updateLocalRuntimeProject(desired as never)).rejects.toThrow()
    expect(updateRuntimeProject).not.toHaveBeenCalled()
  })

  test.each(['name', 'roots', 'defaultProjectSpace'])(
    'rejects an accepted echo with a mismatched %s',
    async field => {
      const { result, upsert, updateRuntimeProject } = setup()
      upsert.mockImplementation(
        async () =>
          ({
            ...update,
            [field]: field === 'roots' ? [...update.roots].reverse() : null,
            accepted: true,
          }) as never
      )
      await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow()
      expect(updateRuntimeProject).not.toHaveBeenCalled()
    }
  )

  test('omits unsupported 1.8.5 metadata and keeps the saved mirror values', async () => {
    const { result, options, upsert, updateRuntimeProject } = setup()
    options.state.devices[1].executor_version = '1.8.5'
    const aiSettings = { instructions: 'Preserved legacy metadata' }
    Object.assign(options.state.runtimeWork.projects[0].project, { aiSettings })
    await result.current.updateLocalRuntimeProject({
      ...update,
      aiSettings: undefined,
      defaultProjectSpace: undefined,
    } as never)
    expect(upsert).toHaveBeenCalledWith({
      deviceId: update.deviceId,
      projectKey: update.projectKey,
      name: update.name,
      roots: update.roots,
      runtime: 'codex',
    })
    expect(updateRuntimeProject).toHaveBeenCalledWith(expect.objectContaining({ aiSettings }))
  })

  test('uses only the existing rename path on an unknown device version', async () => {
    const { result, options, upsert, updateRuntimeProject } = setup()
    options.state.devices[1].executor_version = 'unknown'
    const aiSettings = {
      instructions: 'Preserved',
      plugins: [{ id: 'quality@team', pluginName: 'quality', marketplaceId: 'team' }],
    }
    Object.assign(options.state.runtimeWork.projects[0].project, { aiSettings })
    options.executorClient.runtime.listRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: {
            ...update,
            key: update.projectKey,
            source: 'local_project',
            stateDeviceId: 'remote',
            roots: [{ kind: 'local', path: '/old' }],
            aiSettings,
          },
          deviceWorkspaces: [],
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    await result.current.updateLocalRuntimeProject({
      deviceId: update.deviceId,
      projectKey: update.projectKey,
      name: update.name,
      roots: ['/old'],
    })
    expect(upsert).not.toHaveBeenCalled()
    expect(options.executorClient.runtime.renameRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'remote',
      projectKey: 'owner-key',
      workspacePath: '/old',
      runtime: 'codex',
      name: update.name,
    })
    expect(updateRuntimeProject).toHaveBeenCalledWith(
      expect.objectContaining({ roots: ['/old'], aiSettings })
    )
  })

  test('confirms a legacy rename from owner workspace paths when its roots field is absent', async () => {
    const { result, options, upsert, updateRuntimeProject } = setup()
    options.state.devices[1].executor_version = 'unknown'
    options.executorClient.runtime.listRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: {
            key: update.projectKey,
            name: update.name,
            source: 'local_project',
            stateDeviceId: 'remote',
          },
          deviceWorkspaces: [
            { deviceId: 'remote', workspacePath: '/old', tasks: [], available: true },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    } as never)
    await result.current.updateLocalRuntimeProject({
      deviceId: update.deviceId,
      projectKey: update.projectKey,
      name: update.name,
      roots: ['/old'],
    })
    expect(upsert).not.toHaveBeenCalled()
    expect(updateRuntimeProject).toHaveBeenCalledWith(expect.objectContaining({ roots: ['/old'] }))
  })

  test('confirms the real legacy rename RPC acknowledgement without an unprovided deviceId', async () => {
    const { result, options, upsert, updateRuntimeProject } = setup()
    options.state.devices[1].executor_version = 'unknown'
    const ownerApi = createRuntimeWorkApiFromIpc(
      async method =>
        method === 'runtime.workspaces.rename'
          ? { success: true, accepted: true, workspacePath: '/old', runtime: 'codex' }
          : {
              workspaces: [
                {
                  workspacePath: '/old',
                  projectKey: update.projectKey,
                  label: update.name,
                  tasks: [],
                },
              ],
            },
      async () => 'remote'
    )
    options.executorClient.runtime.renameRuntimeWorkspace.mockImplementation(
      data => ownerApi.renameRuntimeWorkspace(data) as never
    )
    options.executorClient.runtime.listRuntimeWork.mockImplementation(requestOptions =>
      ownerApi.listRuntimeWork(requestOptions)
    )
    await result.current.updateLocalRuntimeProject({
      deviceId: update.deviceId,
      projectKey: update.projectKey,
      name: update.name,
      roots: ['/old'],
    })
    expect(upsert).not.toHaveBeenCalled()
    expect(updateRuntimeProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: update.name, roots: ['/old'] })
    )
  })

  test('rejects a modern owner snapshot that drops supported roots even when a workspace remains', async () => {
    const { result, options, updateRuntimeProject } = setup()
    options.executorClient.runtime.listRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: {
            ...update,
            key: update.projectKey,
            source: 'local_project',
            stateDeviceId: 'remote',
            roots: undefined,
          },
          deviceWorkspaces: [
            { deviceId: 'remote', workspacePath: '/new', tasks: [], available: true },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    } as never)
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow()
    expect(updateRuntimeProject).not.toHaveBeenCalled()
  })

  test('blocks programmatic plugin changes when explicitly unsupported', async () => {
    const { result, options, upsert } = setup()
    Object.assign(options.state.devices[1], {
      runtime_features: {
        schemaVersion: 4,
        projectEditing: {
          multiRoots: true,
          aiSettings: true,
          defaultProjectSpace: true,
          plugins: false,
        },
      },
    })
    await expect(
      result.current.updateLocalRuntimeProject({
        ...update,
        aiSettings: {
          plugins: [{ id: 'quality@team', pluginName: 'quality', marketplaceId: 'team' }],
        },
      } as never)
    ).rejects.toThrow()
    expect(upsert).not.toHaveBeenCalled()
  })

  test('rejects an owner readback mismatch even when the upsert echo matches', async () => {
    const { result, options, updateRuntimeProject, sync } = setup()
    options.executorClient.runtime.listRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: {
            ...update,
            key: update.projectKey,
            source: 'local_project',
            stateDeviceId: 'remote',
            name: 'Old',
            roots: update.roots.map(path => ({ kind: 'local', path })),
          },
          deviceWorkspaces: [],
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow()
    expect(updateRuntimeProject).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  test('rejects unsupported AI edits before sending to verified 1.8.5', async () => {
    const { result, upsert, options } = setup()
    options.state.devices[1].executor_version = '1.8.5'
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow()
    expect(upsert).not.toHaveBeenCalled()
  })

  test('rejects offline saves programmatically before dispatch', async () => {
    const { result, upsert, options } = setup()
    options.state.devices[1].status = 'offline'
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow()
    expect(upsert).not.toHaveBeenCalled()
  })

  test('saves supported AI independently when explicit folder editing is disabled', async () => {
    const { result, options, upsert } = setup()
    Object.assign(options.state.devices[1], {
      runtime_features: {
        schemaVersion: 4,
        projectEditing: { multiRoots: false, aiSettings: true, plugins: false },
      },
    })
    upsert.mockImplementation(async data => ({
      ...(data as typeof update),
      accepted: true,
      error: null,
    }))
    await result.current.updateLocalRuntimeProject({
      ...update,
      roots: ['/old'],
      defaultProjectSpace: undefined,
    } as never)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ roots: ['/old'], aiSettings: update.aiSettings })
    )
  })

  test('keeps the draft unconfirmed when the owning runtime changes during save', async () => {
    const { result, rerender, upsert, options, updateRuntimeProject } = setup()
    let accept!: (response: unknown) => void
    upsert.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve as never
        }) as never
    )
    const saving = result.current.updateLocalRuntimeProject(update as never)
    await waitFor(() => expect(upsert).toHaveBeenCalled())
    options.state.devices = options.state.devices.map(device =>
      device.device_id === 'remote' ? { ...device, runtime_instance_id: 'replacement' } : device
    )
    rerender()
    accept({ ...update, accepted: true })
    await expect(saving).rejects.toThrow()
    expect(updateRuntimeProject).not.toHaveBeenCalled()
  })

  test('confirms a save when concurrent task activity only changes online to busy', async () => {
    const { result, rerender, upsert, options, updateRuntimeProject } = setup()
    let accept!: (response: unknown) => void
    upsert.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve as never
        }) as never
    )
    const saving = result.current.updateLocalRuntimeProject(update as never)
    await waitFor(() => expect(upsert).toHaveBeenCalled())
    options.state.devices = options.state.devices.map(device =>
      device.device_id === 'remote' ? { ...device, status: 'busy' } : device
    )
    rerender()
    accept({ ...update, accepted: true })
    await expect(saving).resolves.toBeUndefined()
    expect(updateRuntimeProject).toHaveBeenCalledWith(update)
  })

  test('serializes mirror writes using the latest confirmed settings instead of a queued stale edit', async () => {
    const queued: Array<() => Promise<void>> = []
    const { result, upsert, sync } = setup(
      true,
      true,
      mutation =>
        new Promise((resolve, reject) =>
          queued.push(async () => {
            try {
              resolve(await mutation())
            } catch (error) {
              reject(error)
            }
          })
        )
    )
    upsert.mockImplementation(async data => ({ ...data, accepted: true, error: null }))
    const first = result.current.updateLocalRuntimeProject(update as never)
    await waitFor(() => expect(queued).toHaveLength(1))
    const latest = { ...update, name: 'Latest', roots: ['/latest'] }
    const second = result.current.updateLocalRuntimeProject(latest as never)
    await waitFor(() => expect(queued).toHaveLength(2))
    await queued[0]()
    await queued[1]()
    await Promise.all([first, second])
    expect(sync.mock.calls[0][0]).toMatchObject({
      projects: [
        expect.objectContaining({ label: 'Latest', remotePath: '/latest', roots: ['/latest'] }),
      ],
    })
  })
})
