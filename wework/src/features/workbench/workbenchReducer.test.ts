import { describe, expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { runtimeProjectUiId } from '@/lib/runtime-project'

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

  test('keeps selected runtime project when refreshed backend projects are empty', () => {
    const runtimeWork = {
      projects: [
        {
          project: {
            key: 'local:/Users/me/Wegent',
            name: 'Wegent',
          },
          totalLocalTasks: 0,
          deviceWorkspaces: [
            {
              id: null,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online' as const,
              available: true,
              workspacePath: '/Users/me/Wegent',
              workspaceKind: 'workspace',
              mapped: true,
              localTasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalLocalTasks: 0,
    }
    const projectId = runtimeProjectUiId(runtimeWork.projects[0].project)
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: projectId, name: 'Wegent', tasks: [] },
    })

    const refreshed = workbenchReducer(selected, {
      type: 'lists_refreshed',
      projects: [],
      devices: [],
      runtimeWork,
    })

    expect(refreshed.currentProject).toMatchObject({
      id: projectId,
      name: 'Wegent',
      config: {
        execution: { targetType: 'local', deviceId: 'local-device' },
        workspace: { source: 'local_path', localPath: '/Users/me/Wegent' },
      },
    })
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

  test('reconciles legacy local-device current task to the refreshed ready device id', () => {
    const state = {
      ...initialWorkbenchState,
      currentRuntimeTask: {
        deviceId: 'local-device',
        localTaskId: 'task-1',
      },
    }

    const refreshed = workbenchReducer(state, {
      type: 'lists_refreshed',
      projects: [],
      devices: [
        {
          id: 1,
          device_id: 'device-uuid',
          name: 'Local Executor',
          status: 'online' as const,
          is_default: true,
        },
      ],
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'device-uuid',
            workspacePath: '/Users/me/chat',
            available: true,
            mapped: true,
            localTasks: [
              {
                localTaskId: 'task-1',
                workspacePath: '/Users/me/chat',
                title: 'Chat',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalLocalTasks: 1,
      },
    })

    expect(refreshed.currentRuntimeTask).toEqual({
      deviceId: 'device-uuid',
      localTaskId: 'task-1',
    })
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

  test('preserves runtime task order on refresh and appends new tasks', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/repo',
                available: true,
                mapped: true,
                localTasks: [
                  {
                    localTaskId: 'task-a',
                    workspacePath: '/workspace/repo',
                    title: 'Task A',
                    runtime: 'codex',
                  },
                  {
                    localTaskId: 'task-b',
                    workspacePath: '/workspace/repo',
                    title: 'Task B',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 2,
      },
    })

    const refreshed = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/repo',
                available: true,
                mapped: true,
                localTasks: [
                  {
                    localTaskId: 'task-b',
                    workspacePath: '/workspace/repo',
                    title: 'Task B updated',
                    runtime: 'codex',
                    running: true,
                  },
                  {
                    localTaskId: 'task-a',
                    workspacePath: '/workspace/repo',
                    title: 'Task A updated',
                    runtime: 'codex',
                  },
                  {
                    localTaskId: 'task-c',
                    workspacePath: '/workspace/repo',
                    title: 'Task C',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 3,
      },
    })

    expect(
      refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].localTasks.map(
        task => task.localTaskId
      )
    ).toEqual(['task-a', 'task-b', 'task-c'])
    expect(refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].localTasks[1]).toMatchObject({
      title: 'Task B updated',
      running: true,
    })
  })

  test('drops an optimistic runtime task when refresh returns it in a different workspace kind', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/repo',
                workspaceKind: 'workspace',
                projectId: 7,
                available: true,
                mapped: true,
                localTasks: [
                  {
                    localTaskId: 'codex-1',
                    workspacePath: '/workspace/repo',
                    title: 'Create cloud config',
                    runtime: 'codex',
                    status: 'creating',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 1,
      },
    })

    const refreshed = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/repo/.worktrees/codex-1',
                workspaceKind: 'worktree',
                projectId: 7,
                available: true,
                mapped: true,
                localTasks: [
                  {
                    localTaskId: 'codex-1',
                    workspacePath: '/workspace/repo/.worktrees/codex-1',
                    title: 'Create cloud config',
                    runtime: 'codex',
                    running: true,
                    status: 'running',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 1,
      },
    })

    const taskItems =
      refreshed.runtimeWork?.projects.flatMap(project =>
        project.deviceWorkspaces.flatMap(workspace => workspace.localTasks)
      ) ?? []

    expect(taskItems.map(task => task.localTaskId)).toEqual(['codex-1'])
    expect(taskItems[0]).toMatchObject({
      workspacePath: '/workspace/repo/.worktrees/codex-1',
      status: 'running',
    })
    expect(refreshed.runtimeWork?.totalLocalTasks).toBe(1)
  })

  test('keeps chat and project workspace task ordering separate when paths overlap', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [{ id: 7, name: 'Repo', tasks: [] }],
      devices: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/shared',
                workspaceKind: 'workspace',
                projectId: 7,
                available: true,
                mapped: true,
                localTasks: [
                  {
                    localTaskId: 'project-task',
                    workspacePath: '/workspace/shared',
                    title: 'Project task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [
          {
            deviceId: 'device-1',
            workspacePath: '/workspace/shared',
            workspaceKind: 'chat',
            available: true,
            mapped: true,
            localTasks: [
              {
                localTaskId: 'chat-b',
                workspacePath: '/workspace/shared',
                title: 'Chat B',
                runtime: 'codex',
              },
              {
                localTaskId: 'chat-a',
                workspacePath: '/workspace/shared',
                title: 'Chat A',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalLocalTasks: 3,
      },
    })

    const refreshed = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/shared',
                workspaceKind: 'workspace',
                projectId: 7,
                available: true,
                mapped: true,
                localTasks: [
                  {
                    localTaskId: 'project-task',
                    workspacePath: '/workspace/shared',
                    title: 'Project task updated',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [
          {
            deviceId: 'device-1',
            workspacePath: '/workspace/shared',
            workspaceKind: 'chat',
            available: true,
            mapped: true,
            localTasks: [
              {
                localTaskId: 'chat-a',
                workspacePath: '/workspace/shared',
                title: 'Chat A updated',
                runtime: 'codex',
              },
              {
                localTaskId: 'chat-b',
                workspacePath: '/workspace/shared',
                title: 'Chat B updated',
                runtime: 'codex',
              },
              {
                localTaskId: 'chat-c',
                workspacePath: '/workspace/shared',
                title: 'Chat C',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalLocalTasks: 4,
      },
    })

    expect(refreshed.runtimeWork?.chats[0].localTasks.map(task => task.localTaskId)).toEqual([
      'chat-b',
      'chat-a',
      'chat-c',
    ])
    expect(refreshed.runtimeWork?.chats[0].localTasks[0]).toMatchObject({
      title: 'Chat B updated',
    })
  })
})
