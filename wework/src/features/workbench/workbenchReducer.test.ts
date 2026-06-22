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
      unmappedDeviceWorkspaces: [],
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
})
