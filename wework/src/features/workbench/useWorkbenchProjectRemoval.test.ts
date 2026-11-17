import '@/i18n'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { useWorkbenchProjectActions } from './useWorkbenchProjectActions'
import { initialWorkbenchState } from './workbenchReducer'

type Options = Parameters<typeof useWorkbenchProjectActions>[0]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(listed = true) {
  const refresh = deferred<void>()
  const remove = vi.fn().mockResolvedValue({ accepted: true })
  const project = {
    key: '/srv/project',
    name: 'Cloud project',
    stateDeviceId: 'local',
    sidebarStateKey: 'remote-index',
    source: 'remote_project' as const,
  }
  const options: Options = {
    ownershipKey: 'test',
    state: {
      ...initialWorkbenchState,
      standaloneDeviceId: 'remote',
      standaloneWorkspacePath: '/srv/project',
      runtimeWork: {
        projects: listed
          ? [
              {
                project,
                deviceWorkspaces: [
                  {
                    deviceId: 'remote',
                    remoteHostId: 'remote',
                    workspacePath: '/srv/project',
                    available: true,
                    tasks: [],
                  },
                ],
                totalTasks: 0,
              },
            ]
          : [],
        chats: [],
        totalTasks: 0,
      },
    },
    dispatch: vi.fn(),
    executorClient: {
      runtime: { removeRuntimeWorkspace: remove },
    } as unknown as Options['executorClient'],
    services: { projectApi: {} } as Options['services'],
    refreshWorkLists: vi.fn(() => refresh.promise),
    updateRuntimeProject: vi.fn(),
    getRuntimeWorkSnapshot: () => options.state.runtimeWork,
    getRemoteProjectRegistrations: () => [],
    updateLocalRuntimeTaskPinned: vi.fn(),
    rollbackLocalRuntimeTaskPinned: vi.fn(),
    markRuntimeProjectRemoved: vi.fn(),
    invalidateRemoteProjectSync: vi.fn(),
    clearRemoteProjectSyncRemoval: vi.fn(),
    enqueueRemoteProjectStateMutation: mutation => mutation(),
  }
  const projectId = runtimeProjectUiId(
    listed
      ? project
      : {
          key: '/srv/project',
          stateDeviceId: 'remote',
          name: '/srv/project',
        }
  )
  const { result } = renderHook(() => useWorkbenchProjectActions(options))
  return { result, options, projectId, remove, refresh }
}

describe('runtime project removal completion', () => {
  test.each([true, false])(
    'completes listed=%s removal while list refresh is pending',
    async listed => {
      const { result, options, projectId, remove, refresh } = setup(listed)
      const refreshing = options.refreshWorkLists()
      let completed = false
      const removing = result.current.removeProject(projectId).then(() => {
        completed = true
      })
      try {
        await waitFor(() => expect(remove).toHaveBeenCalledTimes(listed ? 2 : 1))
        expect(options.markRuntimeProjectRemoved).toHaveBeenCalledWith(projectId, {
          deviceId: 'remote',
          workspacePath: '/srv/project',
        })
        await waitFor(() => expect(completed).toBe(true))
        expect(options.refreshWorkLists).toHaveBeenCalledTimes(1)
        expect(options.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'project_cleared',
            standaloneWorkspacePath: null,
            startFreshChat: true,
          })
        )
        if (listed)
          expect(options.dispatch).toHaveBeenCalledWith({
            type: 'runtime_project_removed',
            projectId,
          })
      } finally {
        refresh.resolve()
        await Promise.all([removing, refreshing])
      }
    }
  )

  test('waits for both owner and local index removal before publishing success', async () => {
    const { result, options, projectId, remove, refresh } = setup()
    const indexRemoval = deferred<{ accepted: boolean }>()
    remove
      .mockImplementationOnce(async () => ({ accepted: true }))
      .mockImplementationOnce(() => indexRemoval.promise)
    const removing = result.current.removeProject(projectId)
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
    expect(options.markRuntimeProjectRemoved).not.toHaveBeenCalled()
    expect(options.refreshWorkLists).not.toHaveBeenCalled()
    indexRemoval.resolve({ accepted: true })
    refresh.resolve()
    await removing
    expect(options.markRuntimeProjectRemoved).toHaveBeenCalled()
  })

  test.each([1, 2])('keeps the project and reports rejection at removal step %s', async step => {
    const { result, options, projectId, remove } = setup()
    if (step === 2) remove.mockResolvedValueOnce({ accepted: true })
    remove.mockResolvedValueOnce({ accepted: false, error: 'Removal denied' })
    await expect(result.current.removeProject(projectId)).rejects.toThrow('Removal denied')
    expect(options.markRuntimeProjectRemoved).not.toHaveBeenCalled()
    expect(options.refreshWorkLists).not.toHaveBeenCalled()
    expect(options.dispatch).toHaveBeenCalledWith({ type: 'error_set', error: 'Removal denied' })
  })

  test('does not turn a confirmed removal into a failure when refresh rejects', async () => {
    const { result, options, projectId } = setup()
    vi.mocked(options.refreshWorkLists).mockRejectedValue(new Error('List unavailable'))
    await expect(result.current.removeProject(projectId)).resolves.toBeUndefined()
    expect(options.refreshWorkLists).not.toHaveBeenCalled()
    expect(options.dispatch).toHaveBeenCalledWith({ type: 'runtime_project_removed', projectId })
  })
})
