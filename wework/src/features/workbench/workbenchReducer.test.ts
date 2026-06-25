import { describe, expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

describe('workbenchReducer', () => {
  test('selects a project and keeps runtime task empty', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })

    expect(state.currentProject?.id).toBe(7)
    expect(state.currentRuntimeTask).toBeNull()
  })

  test('stores runtime work separately from backend task lists', () => {
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          totalLocalTasks: 1,
          deviceWorkspaces: [
            {
              id: 3,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              label: 'Wegent',
              localTasks: [
                {
                  localTaskId: 'codex-1',
                  workspacePath: '/repo/Wegent',
                  title: 'Fix reconnect',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalLocalTasks: 1,
    }

    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      runtimeWork,
    })

    expect(state.runtimeWork).toBe(runtimeWork)
    expect(state.projects[0].tasks).toEqual([])
  })

  test('clears selected project when opening a standalone runtime task', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(selected, {
      type: 'runtime_task_opened',
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/default',
        localTaskId: 'runtime-1',
      },
      project: null,
    })

    expect(opened.currentProject).toBeNull()
    expect(opened.currentRuntimeTask?.localTaskId).toBe('runtime-1')
  })

  test('keeps project tasks only in the project list returned by the server', () => {
    const refreshed = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [
        {
          id: 7,
          name: 'Repo',
          tasks: [
            {
              id: 42,
              task_id: 42,
              task_title: 'Project chat',
              task_status: 'RUNNING',
              title: 'Project chat',
              status: 'RUNNING',
              task_type: 'code',
              created_at: '2026-05-25T00:00:00.000Z',
            },
          ],
        },
      ],
      devices: [],
    })

    expect(refreshed.projects[0].tasks).toHaveLength(1)
  })

  test('optimistically adds a prepared device workspace', () => {
    const base = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [
        {
          id: 1,
          device_id: 'device-1',
          name: 'Device 1',
          status: 'online',
          is_default: false,
        },
      ],
      runtimeWork: {
        projects: [{ project: { id: 7, name: 'Repo' }, deviceWorkspaces: [] }],
        chats: [
          {
            deviceId: 'device-1',
            workspacePath: '/workspace/repo',
            available: true,
            mapped: false,
            localTasks: [],
          },
        ],
        totalLocalTasks: 0,
      },
    })

    const updated = workbenchReducer(base, {
      type: 'device_workspace_prepared',
      mapping: {
        id: 22,
        userId: 1,
        projectId: 7,
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        lastSeenAt: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
      },
    })

    expect(updated.selectedDeviceWorkspaceId).toBe(22)
    expect(updated.runtimeWork?.projects[0].deviceWorkspaces).toEqual([
      expect.objectContaining({
        id: 22,
        projectId: 7,
        deviceId: 'device-1',
        deviceName: 'Device 1',
        workspacePath: '/workspace/repo',
        mapped: true,
      }),
    ])
    expect(updated.runtimeWork?.chats).toEqual([])
  })

  test('keeps existing devices when a device refresh returns a transient empty list', () => {
    const device = {
      id: 1,
      device_id: 'device-1',
      name: 'Device 1',
      status: 'online' as const,
      is_default: false,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      update_available: true,
    }
    const state = {
      ...initialWorkbenchState,
      devices: [device],
    }

    const refreshed = workbenchReducer(state, {
      type: 'devices_refreshed',
      devices: [],
    })

    expect(refreshed.devices).toEqual([device])
  })

  test('keeps existing devices when worklist refresh returns a transient empty device list', () => {
    const device = {
      id: 1,
      device_id: 'device-1',
      name: 'Device 1',
      status: 'online' as const,
      is_default: false,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      update_available: true,
    }
    const state = {
      ...initialWorkbenchState,
      devices: [device],
    }

    const refreshed = workbenchReducer(state, {
      type: 'lists_refreshed',
      projects: [],
      devices: [],
    })

    expect(refreshed.devices).toEqual([device])
  })

  test('updates cached device and runtime workspace status from websocket events', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [
        {
          id: 1,
          device_id: 'device-1',
          name: 'Device 1',
          status: 'offline' as const,
          is_default: false,
          bind_shell: 'claudecode',
          executor_version: '1.8.5',
        },
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                id: 22,
                projectId: 7,
                deviceId: 'device-1',
                deviceName: 'Device 1',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/workspace/repo',
                mapped: true,
                localTasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 0,
      },
    })

    const updated = workbenchReducer(state, {
      type: 'device_status_changed',
      deviceId: 'device-1',
      status: 'online',
    })

    expect(updated.devices[0].status).toBe('online')
    expect(updated.runtimeWork?.projects[0].deviceWorkspaces[0]).toMatchObject({
      deviceStatus: 'online',
      available: true,
    })
  })
})
