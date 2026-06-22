import { describe, expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

describe('workbenchReducer', () => {
  test('selects a project and keeps current task empty', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })

    expect(state.currentProject?.id).toBe(7)
    expect(state.currentTask).toBeNull()
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

  test('opens task and leaves selected project unchanged', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(selected, {
      type: 'task_opened',
      task: {
        id: 3,
        title: '历史会话',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })

    expect(opened.currentProject?.id).toBe(7)
    expect(opened.currentTask?.id).toBe(3)
  })

  test('opens task with explicit project context', () => {
    const opened = workbenchReducer(initialWorkbenchState, {
      type: 'task_opened',
      task: {
        id: 3,
        title: '历史会话',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
      project: { id: 9, name: 'sina-sso', tasks: [] },
    })

    expect(opened.currentProject?.id).toBe(9)
    expect(opened.currentProject?.name).toBe('sina-sso')
    expect(opened.currentTask?.id).toBe(3)
    expect(opened.currentTask?.project_id).toBe(9)
  })

  test('normalizes project task detail before updating work lists', () => {
    const bootstrapped = workbenchReducer(initialWorkbenchState, {
      type: 'bootstrapped',
      user: { id: 1, user_name: 'admin', email: 'admin@example.com' },
      defaultTeam: null,
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      currentProject: { id: 7, name: 'Repo', tasks: [] },
    })

    const opened = workbenchReducer(bootstrapped, {
      type: 'task_opened',
      task: {
        id: 12,
        title: 'Project prompt',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
      project: { id: 7, name: 'Repo', tasks: [] },
    })

    expect(opened.currentTask?.project_id).toBe(7)
    expect(opened.projects[0].tasks).toEqual([
      expect.objectContaining({
        task_id: 12,
        task_title: 'Project prompt',
        task_status: 'COMPLETED',
      }),
    ])
  })

  test('opens a standalone legacy task without materializing a DB sidebar list', () => {
    const opened = workbenchReducer(initialWorkbenchState, {
      type: 'task_opened',
      task: {
        id: 11,
        title: 'Standalone prompt',
        status: 'RUNNING',
        task_type: 'code',
        project_id: 0,
        device_id: 'local-1',
        created_at: '2026-05-25T00:00:00.000Z',
      },
      project: null,
    })

    expect(opened.currentTask).toMatchObject({
      id: 11,
      title: 'Standalone prompt',
      device_id: 'local-1',
    })
    expect(opened.currentProject).toBeNull()
  })

  test('adds a newly opened project task to that project immediately', () => {
    const bootstrapped = workbenchReducer(initialWorkbenchState, {
      type: 'bootstrapped',
      user: { id: 1, user_name: 'admin', email: 'admin@example.com' },
      defaultTeam: null,
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      currentProject: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(bootstrapped, {
      type: 'task_opened',
      task: {
        id: 12,
        title: 'Project prompt',
        status: 'RUNNING',
        task_type: 'code',
        project_id: 7,
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })

    expect(opened.projects[0].tasks).toEqual([
      expect.objectContaining({
        task_id: 12,
        task_title: 'Project prompt',
        task_status: 'RUNNING',
      }),
    ])
  })

  test('preserves current standalone task when a worklist refresh has no DB task list', () => {
    const opened = workbenchReducer(initialWorkbenchState, {
      type: 'task_opened',
      task: {
        id: 11,
        title: 'Standalone prompt',
        status: 'RUNNING',
        task_type: 'code',
        project_id: 0,
        created_at: '2026-05-25T00:00:00.000Z',
      },
      project: null,
    })
    const completed = workbenchReducer(opened, {
      type: 'task_status_changed',
      taskId: 11,
      status: 'COMPLETED',
    })
    const staleRefresh = workbenchReducer(completed, {
      type: 'lists_refreshed',
      projects: [],
      devices: [],
    })

    expect(staleRefresh.currentTask).toMatchObject({ id: 11, status: 'COMPLETED' })
  })

  test('updates model selection only on the current task state', () => {
    const opened = workbenchReducer(initialWorkbenchState, {
      type: 'task_opened',
      task: {
        id: 11,
        title: 'Standalone prompt',
        status: 'RUNNING',
        task_type: 'code',
        project_id: 0,
        model_id: 'claude-sonnet-4-5',
        force_override_bot_model_type: 'public',
        created_at: '2026-05-25T00:00:00.000Z',
      },
      project: null,
    })
    const updated = workbenchReducer(opened, {
      type: 'current_task_model_selection_changed',
      selection: {
        modelName: 'claude-opus-4-6',
        modelType: 'user',
        options: {},
      },
    })

    expect(updated.currentTask).toMatchObject({
      id: 11,
      model_id: 'claude-opus-4-6',
      force_override_bot_model_type: 'user',
      model_options: {},
    })
  })

  test('clears the current task without changing the selected project', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(selected, {
      type: 'task_opened',
      task: {
        id: 3,
        title: '历史会话',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })
    const cleared = workbenchReducer(opened, { type: 'current_task_cleared' })

    expect(cleared.currentProject?.id).toBe(7)
    expect(cleared.currentTask).toBeNull()
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
    expect(opened.currentTask).toBeNull()
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

  test('re-adds a missing current project task after a stale project refresh', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(selected, {
      type: 'task_opened',
      task: {
        id: 42,
        title: 'Project chat',
        status: 'RUNNING',
        task_type: 'code',
        project_id: 7,
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })
    // Server hasn't associated the task with the project yet, so the project
    // list is temporarily missing the current task.
    const refreshed = workbenchReducer(opened, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
    })

    expect(refreshed.projects[0].tasks).toEqual([expect.objectContaining({ task_id: 42 })])
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
