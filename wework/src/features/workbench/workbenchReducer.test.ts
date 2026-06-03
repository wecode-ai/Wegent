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
    expect(opened.recentTasks).toEqual([])
  })

  test('normalizes project task detail before updating work lists', () => {
    const bootstrapped = workbenchReducer(initialWorkbenchState, {
      type: 'bootstrapped',
      user: { id: 1, user_name: 'admin', email: 'admin@example.com' },
      defaultTeam: null,
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      recentTasks: [],
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
    expect(opened.recentTasks).toEqual([])
    expect(opened.projects[0].tasks).toEqual([
      expect.objectContaining({
        task_id: 12,
        task_title: 'Project prompt',
        task_status: 'COMPLETED',
      }),
    ])
  })

  test('adds a newly opened standalone task to recent chats immediately', () => {
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

    expect(opened.recentTasks).toHaveLength(1)
    expect(opened.recentTasks[0]).toMatchObject({
      id: 11,
      title: 'Standalone prompt',
      device_id: 'local-1',
    })
  })

  test('adds a newly opened project task to that project immediately', () => {
    const bootstrapped = workbenchReducer(initialWorkbenchState, {
      type: 'bootstrapped',
      user: { id: 1, user_name: 'admin', email: 'admin@example.com' },
      defaultTeam: null,
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      recentTasks: [],
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

  test('preserves current task when a stale list refresh misses it', () => {
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
      recentTasks: [],
    })

    expect(staleRefresh.recentTasks).toEqual([
      expect.objectContaining({ id: 11, status: 'COMPLETED' }),
    ])
  })

  test('re-adds current task after a stale list refresh without regressing status', () => {
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
    const staleRefresh = {
      ...workbenchReducer(completed, {
        type: 'lists_refreshed',
        projects: [],
        devices: [],
        recentTasks: [],
      }),
      recentTasks: [],
    }
    const reinserted = workbenchReducer(staleRefresh, {
      type: 'task_upserted',
      task: {
        id: 11,
        title: 'Standalone prompt',
        status: 'RUNNING',
        task_type: 'code',
        project_id: 0,
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })

    expect(reinserted.recentTasks).toEqual([
      expect.objectContaining({ id: 11, status: 'COMPLETED' }),
    ])
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
    expect(updated.recentTasks[0]).toMatchObject({
      id: 11,
      model_id: 'claude-sonnet-4-5',
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
})
