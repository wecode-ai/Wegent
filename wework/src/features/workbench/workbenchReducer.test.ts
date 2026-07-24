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

  test('removes a deleted cloud project from the visible project state', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        projects: [
          { id: 7, name: 'Deleted project', tasks: [] },
          { id: 8, name: 'Retained project', tasks: [] },
        ],
        currentProject: { id: 7, name: 'Deleted project', tasks: [] },
      },
      { type: 'project_removed', projectId: 7 }
    )

    expect(state.projects.map(project => project.id)).toEqual([8])
    expect(state.currentProject).toBeNull()
  })

  test('preserves the current blank chat draft when clearing the runtime task', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        currentProject: { id: 7, name: 'Repo', tasks: [] },
        currentRuntimeTask: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        standaloneChatKey: 4,
      },
      { type: 'current_task_cleared' }
    )

    expect(state.currentRuntimeTask).toBeNull()
    expect(state.standaloneChatKey).toBe(4)
  })

  test('preserves blank chat draft when returning to standalone chat', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        currentRuntimeTask: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        standaloneChatKey: 4,
      },
      {
        type: 'project_cleared',
        standaloneDeviceId: 'device-1',
        standaloneWorkspacePath: null,
      }
    )

    expect(state.currentRuntimeTask).toBeNull()
    expect(state.standaloneChatKey).toBe(4)
  })

  test('creates a fresh blank chat draft when requested explicitly', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        standaloneChatKey: 4,
      },
      {
        type: 'project_cleared',
        standaloneDeviceId: 'device-1',
        standaloneWorkspacePath: null,
        startFreshChat: true,
      }
    )

    expect(state.standaloneChatKey).toBe(5)
  })

  test('creates a fresh blank chat draft after the previous draft is committed', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        standaloneChatKey: 4,
      },
      { type: 'blank_chat_committed' }
    )

    expect(state.standaloneChatKey).toBe(5)
  })

  test('preserves blank chat draft when selecting a project', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        standaloneChatKey: 4,
      },
      {
        type: 'project_selected',
        project: { id: 7, name: 'Repo', tasks: [] },
      }
    )

    expect(state.currentProject?.id).toBe(7)
    expect(state.standaloneChatKey).toBe(4)
  })

  test('preserves blank chat draft when selecting a project workspace', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        standaloneChatKey: 4,
      },
      {
        type: 'project_workspace_selected',
        project: { id: 7, name: 'Repo', tasks: [] },
        deviceWorkspaceId: null,
      }
    )

    expect(state.currentProject?.id).toBe(7)
    expect(state.pendingProjectWorkspaceProjectId).toBe(7)
    expect(state.standaloneChatKey).toBe(4)
  })

  test('stores runtime work separately from backend task lists', () => {
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          totalTasks: 1,
          deviceWorkspaces: [
            {
              id: 3,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              label: 'Wegent',
              tasks: [
                {
                  taskId: 'codex-1',
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
      totalTasks: 1,
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
          totalTasks: 0,
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
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
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

  test('selects the runtime project when opening a standalone workspace', () => {
    const state = {
      ...initialWorkbenchState,
      devices: [
        {
          id: 1,
          device_id: 'device-1',
          name: 'Local Mac',
          status: 'online' as const,
          is_default: true,
          bind_shell: 'claudecode',
          executor_version: '1.8.5',
        },
      ],
      currentRuntimeTask: {
        deviceId: 'device-1',
        workspacePath: '/workspace/old',
        taskId: 'old-task',
      },
    }

    const opened = workbenchReducer(state, {
      type: 'runtime_workspace_opened',
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      label: 'Direct Codex',
    })

    expect(opened.currentProject).toMatchObject({
      name: 'Direct Codex',
      config: {
        execution: { targetType: 'local', deviceId: 'device-1' },
        workspace: { source: 'local_path', localPath: '/workspace/direct-codex' },
      },
    })
    expect(opened.selectedDeviceWorkspaceId).toBeNull()
    expect(opened.pendingProjectWorkspaceProjectId).toBeNull()
    expect(opened.currentRuntimeTask).toBeNull()
    expect(opened.standaloneDeviceId).toBe('device-1')
    expect(opened.standaloneWorkspacePath).toBe('/workspace/direct-codex')
    expect(opened.standaloneChatKey).toBe(state.standaloneChatKey + 1)
  })

  test('starts a fresh blank pane when creating a new project conversation', () => {
    const selected = workbenchReducer(
      { ...initialWorkbenchState, standaloneChatKey: 4 },
      {
        type: 'project_workspace_selected',
        project: { id: 7, name: 'Repo', tasks: [] },
        deviceWorkspaceId: 22,
        startFreshChat: true,
      }
    )

    expect(selected.currentProject?.id).toBe(7)
    expect(selected.selectedDeviceWorkspaceId).toBe(22)
    expect(selected.standaloneChatKey).toBe(5)
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
        taskId: 'runtime-1',
      },
      project: null,
    })

    expect(opened.currentProject).toBeNull()
    expect(opened.currentRuntimeTask?.taskId).toBe('runtime-1')
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
            tasks: [],
          },
        ],
        totalTasks: 0,
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

  test('places a newly prepared runtime project first before refresh returns codex order', () => {
    const base = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [
        { id: 8, name: 'New Project', tasks: [] },
        { id: 7, name: 'Existing Project', tasks: [] },
      ],
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
        projects: [
          {
            project: { id: 7, name: 'Existing Project' },
            deviceWorkspaces: [
              {
                id: 11,
                projectId: 7,
                deviceId: 'device-1',
                deviceName: 'Device 1',
                deviceStatus: 'online',
                workspacePath: '/workspace/existing',
                available: true,
                mapped: true,
                tasks: [],
              },
            ],
          },
        ],
        chats: [
          {
            deviceId: 'device-1',
            workspacePath: '/workspace/new-project',
            available: true,
            mapped: false,
            tasks: [],
          },
        ],
        totalTasks: 0,
      },
    })

    const updated = workbenchReducer(base, {
      type: 'device_workspace_prepared',
      mapping: {
        id: 22,
        userId: 1,
        projectId: 8,
        deviceId: 'device-1',
        workspacePath: '/workspace/new-project',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        lastSeenAt: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
      },
    })

    expect(
      updated.runtimeWork?.projects.map(project => runtimeProjectUiId(project.project))
    ).toEqual([8, 7])
    expect(updated.runtimeWork?.chats).toEqual([])
  })

  test('uses refreshed codex project order across devices', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [],
      devices: [
        {
          id: 1,
          device_id: 'device-1',
          name: 'Device 1',
          status: 'online',
          is_default: false,
        },
        {
          id: 2,
          device_id: 'device-2',
          name: 'Device 2',
          status: 'online',
          is_default: false,
        },
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 2, name: 'Device 2 Project' },
            deviceWorkspaces: [
              {
                deviceId: 'device-2',
                deviceName: 'Device 2',
                workspacePath: '/workspace/device-2',
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'task-b',
                    workspacePath: '/workspace/device-2',
                    title: 'Task B',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
          {
            project: { id: 1, name: 'Device 1 Project' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                deviceName: 'Device 1',
                workspacePath: '/workspace/device-1',
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'task-a',
                    workspacePath: '/workspace/device-1',
                    title: 'Task A',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
    })

    const refreshed = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { id: 1, name: 'Device 1 Project' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                deviceName: 'Device 1',
                workspacePath: '/workspace/device-1',
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'task-a',
                    workspacePath: '/workspace/device-1',
                    title: 'Task A updated',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
          {
            project: { id: 2, name: 'Device 2 Project' },
            deviceWorkspaces: [
              {
                deviceId: 'device-2',
                deviceName: 'Device 2',
                workspacePath: '/workspace/device-2',
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'task-b',
                    workspacePath: '/workspace/device-2',
                    title: 'Task B updated',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
    })

    expect(
      refreshed.runtimeWork?.projects.map(project => runtimeProjectUiId(project.project))
    ).toEqual([1, 2])
    expect(refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
      taskId: 'task-a',
      title: 'Task A updated',
    })
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

  test.each(['local-device', 'device-uuid'])(
    'reconciles %s current task to the hydrated ready task address',
    currentDeviceId => {
      const state = {
        ...initialWorkbenchState,
        currentRuntimeTask: {
          deviceId: currentDeviceId,
          taskId: 'task-1',
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
              tasks: [
                {
                  taskId: 'task-1',
                  threadId: 'direct-thread-id',
                  workspacePath: '/Users/me/chat',
                  title: 'Chat',
                  runtime: 'codex',
                  runtimeHandle: {
                    threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
                  },
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      })

      expect(refreshed.currentRuntimeTask).toEqual({
        deviceId: 'device-uuid',
        taskId: 'task-1',
        threadId: 'direct-thread-id',
        ...(currentDeviceId === 'local-device' ? { workspacePath: '/Users/me/chat' } : {}),
        runtimeHandle: {
          threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
        },
      })
    }
  )

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
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
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

  test('updates the logical device when a websocket event uses its socket id', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'lists_refreshed',
      projects: [],
      devices: [
        {
          id: 1,
          device_id: 'logical-device',
          socket_device_id: 'socket-device',
          name: 'Remote Device',
          status: 'offline',
          is_default: false,
        },
      ],
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'logical-device',
            deviceStatus: 'offline',
            available: false,
            workspacePath: '/workspace/repo',
            mapped: true,
            tasks: [],
          },
        ],
        totalTasks: 0,
      },
    })

    const updated = workbenchReducer(state, {
      type: 'device_status_changed',
      deviceId: 'socket-device',
      status: 'online',
    })

    expect(updated.devices[0].status).toBe('online')
    expect(updated.runtimeWork?.chats[0]).toMatchObject({
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
                tasks: [
                  {
                    taskId: 'task-a',
                    workspacePath: '/workspace/repo',
                    title: 'Task A',
                    runtime: 'codex',
                  },
                  {
                    taskId: 'task-b',
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
        totalTasks: 2,
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
                tasks: [
                  {
                    taskId: 'task-b',
                    workspacePath: '/workspace/repo',
                    title: 'Task B updated',
                    runtime: 'codex',
                    running: true,
                  },
                  {
                    taskId: 'task-a',
                    workspacePath: '/workspace/repo',
                    title: 'Task A updated',
                    runtime: 'codex',
                  },
                  {
                    taskId: 'task-c',
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
        totalTasks: 3,
      },
    })

    expect(
      refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)
    ).toEqual(['task-a', 'task-b', 'task-c'])
    expect(refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[1]).toMatchObject({
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
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
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
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
      },
    })

    const taskItems =
      refreshed.runtimeWork?.projects.flatMap(project =>
        project.deviceWorkspaces.flatMap(workspace => workspace.tasks)
      ) ?? []

    expect(taskItems.map(task => task.taskId)).toEqual(['codex-1'])
    expect(taskItems[0]).toMatchObject({
      workspacePath: '/workspace/repo/.worktrees/codex-1',
      status: 'running',
    })
    expect(refreshed.runtimeWork?.totalTasks).toBe(1)
  })

  test('preserves a fresh failed optimistic runtime task across refresh', () => {
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
                tasks: [
                  {
                    taskId: 'codex-failed',
                    workspacePath: '/workspace/repo',
                    title: 'Create cloud config',
                    runtime: 'codex',
                    status: 'failed',
                    optimistic: true,
                    error: 'executor-not-found:device-1',
                    updatedAt: new Date().toISOString(),
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
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
                workspaceKind: 'workspace',
                projectId: 7,
                available: true,
                mapped: true,
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    expect(refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks).toEqual([
      expect.objectContaining({
        taskId: 'codex-failed',
        status: 'failed',
        optimistic: true,
        error: 'executor-not-found:device-1',
      }),
    ])
    expect(refreshed.runtimeWork?.totalTasks).toBe(1)
  })

  test('preserves a fresh optimistic task when another task has the same title', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'runtime_task_optimistic_upserted',
      project: { id: 7, name: 'Repo', tasks: [] },
      workspace: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        projectId: 7,
        available: true,
        mapped: true,
        tasks: [],
      },
      task: {
        taskId: 'attachment-only-new',
        workspacePath: '/workspace/repo',
        title: '新对话',
        runtime: 'codex',
        status: 'creating',
        updatedAt: new Date().toISOString(),
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
                projectId: 7,
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'attachment-only-existing',
                    workspacePath: '/workspace/repo',
                    title: '新对话',
                    runtime: 'codex',
                    status: 'done',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
    })

    expect(
      refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)
    ).toEqual(['attachment-only-new', 'attachment-only-existing'])
    expect(refreshed.runtimeWork?.totalTasks).toBe(2)
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
                tasks: [
                  {
                    taskId: 'project-task',
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
            tasks: [
              {
                taskId: 'chat-b',
                workspacePath: '/workspace/shared',
                title: 'Chat B',
                runtime: 'codex',
              },
              {
                taskId: 'chat-a',
                workspacePath: '/workspace/shared',
                title: 'Chat A',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 3,
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
                tasks: [
                  {
                    taskId: 'project-task',
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
            tasks: [
              {
                taskId: 'chat-a',
                workspacePath: '/workspace/shared',
                title: 'Chat A updated',
                runtime: 'codex',
              },
              {
                taskId: 'chat-b',
                workspacePath: '/workspace/shared',
                title: 'Chat B updated',
                runtime: 'codex',
              },
              {
                taskId: 'chat-c',
                workspacePath: '/workspace/shared',
                title: 'Chat C',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 4,
      },
    })

    expect(refreshed.runtimeWork?.chats[0].tasks.map(task => task.taskId)).toEqual([
      'chat-b',
      'chat-a',
      'chat-c',
    ])
    expect(refreshed.runtimeWork?.chats[0].tasks[0]).toMatchObject({
      title: 'Chat B updated',
    })
  })
})
