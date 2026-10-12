import { updateRuntimeWorkProject } from '@/lib/runtime-project-update'
import {
  getLocalRuntimeStateDeviceId,
  getRuntimeRemoteProjectRegistrations,
} from '@/lib/runtime-project-state'
import '@/i18n'
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
    const upsert = vi.fn(async () => ({
      ...update,
      accepted: saveAccepted,
      error: saveAccepted ? null : 'Owner rejected',
    }))
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
          { device_id: 'local', device_type: 'local', status: 'online' },
          { device_id: 'remote', device_type: 'remote', status: 'online' },
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
        runtime: { upsertLocalRuntimeProject: upsert, syncRuntimeRemoteProjects: sync },
      },
      services: { projectApi: {} },
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
    const getRemoteProjectRegistrations = () =>
      getRuntimeRemoteProjectRegistrations(
        getRuntimeWorkSnapshot() as never,
        getLocalRuntimeStateDeviceId(options.state.devices as never),
        { devices: options.state.devices as never }
      )
    const { result } = renderHook(() =>
      useWorkbenchProjectActions({
        ...options,
        getRuntimeWorkSnapshot,
        getRemoteProjectRegistrations,
      } as never)
    )
    return { result, upsert, sync, updateRuntimeProject, refreshWorkLists, events }
  }

  test('saves full metadata on owner before projecting and synchronizing the stable mirror', async () => {
    const { result, upsert, sync, events } = setup()
    await result.current.updateLocalRuntimeProject(update as never)
    expect(upsert).toHaveBeenCalledWith({ ...update, runtime: 'codex' })
    expect(events).toEqual(['projection', 'sync', 'refresh'])
    expect(sync).toHaveBeenCalledWith({
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
    })
  })

  test('retains the confirmed owner settings while surfacing a mirror sync failure', async () => {
    const { result, updateRuntimeProject, refreshWorkLists } = setup(false)
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow(
      'Mirror rejected'
    )
    expect(updateRuntimeProject).toHaveBeenCalledWith(update)
    expect(refreshWorkLists).not.toHaveBeenCalled()
  })

  test('does not project settings or sync when the owner rejects the save', async () => {
    const { result, updateRuntimeProject, sync } = setup(true, false)
    await expect(result.current.updateLocalRuntimeProject(update as never)).rejects.toThrow(
      'Owner rejected'
    )
    expect(updateRuntimeProject).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
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
