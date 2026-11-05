import { describe, expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

describe('workbenchReducer', () => {
  test('moves a fresh composer source selection to the new primary after refresh', () => {
    const project = {
      id: 7,
      key: 'owner',
      name: 'Project',
      source: 'remote_project',
      ownerDeviceId: 'remote',
      ownerProjectKey: 'owner',
      roots: [{ kind: 'local', path: '/old' }],
    }
    const oldWorkspace = {
      id: 11,
      deviceId: 'remote',
      workspacePath: '/old',
      available: true,
      tasks: [],
    }
    const state = {
      ...initialWorkbenchState,
      currentProject: { id: 7, name: 'Project', tasks: [] },
      selectedDeviceWorkspaceId: 11,
      runtimeWork: {
        projects: [{ project, deviceWorkspaces: [oldWorkspace] }],
        chats: [],
        totalTasks: 0,
      },
    }
    const next = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { ...project, roots: [{ kind: 'local', path: '/new' }] },
            deviceWorkspaces: [{ ...oldWorkspace, id: 22, workspacePath: '/new' }],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })
    expect(next.selectedDeviceWorkspaceId).toBe(22)
    const existing = workbenchReducer(
      {
        ...state,
        currentRuntimeTask: { taskId: 'existing', deviceId: 'remote', workspacePath: '/old' },
      },
      { type: 'runtime_work_refreshed', runtimeWork: next.runtimeWork! }
    )
    expect(existing.selectedDeviceWorkspaceId).toBe(11)
    expect(existing.currentRuntimeTask?.workspacePath).toBe('/old')
  })

  test('updates the workbench user when the active identity changes', () => {
    const state = workbenchReducer(
      { ...initialWorkbenchState, user: { id: 1, user_name: 'alice', email: 'a@b.c' } },
      { type: 'user_updated', user: { id: 2, user_name: 'hongyu9', email: 'h@b.c' } }
    )

    expect(state.user?.id).toBe(2)
    expect(state.user?.user_name).toBe('hongyu9')
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

  test('removes a runtime project even while its optimistic task is fresh', () => {
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              available: true,
              workspacePath: '/workspace/repo',
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/repo',
                  title: 'Creating task',
                  runtime: 'codex',
                  status: 'creating',
                  optimistic: true,
                  createdAt: Date.now(),
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        runtimeWork,
        currentProject: { id: 7, name: 'Repo', tasks: [] },
        selectedDeviceWorkspaceId: 22,
        pendingProjectWorkspaceProjectId: 7,
        currentRuntimeTask: {
          deviceId: 'device-1',
          workspacePath: '/workspace/repo',
          taskId: 'runtime-a',
        },
      },
      { type: 'runtime_project_removed', projectId: 7 }
    )

    expect(state.runtimeWork?.projects).toEqual([])
    expect(state.runtimeWork?.totalTasks).toBe(0)
    expect(state.currentProject).toBeNull()
    expect(state.selectedDeviceWorkspaceId).toBeNull()
    expect(state.pendingProjectWorkspaceProjectId).toBeNull()
    expect(state.currentRuntimeTask).toBeNull()
  })

  test('updates only the matching runtime task title without changing its execution state', () => {
    const state = {
      ...initialWorkbenchState,
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
                    taskId: 'runtime-a',
                    workspacePath: '/workspace/repo',
                    title: '原始标题',
                    runtime: 'codex' as const,
                    status: 'succeeded',
                    running: false,
                    threadStatus: 'idle',
                    turnStatus: 'completed' as const,
                  },
                  {
                    taskId: 'runtime-b',
                    workspacePath: '/workspace/repo',
                    title: '不应变更',
                    runtime: 'codex' as const,
                    status: 'running',
                    running: true,
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
    }

    const updated = workbenchReducer(state, {
      type: 'runtime_task_title_updated',
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        taskId: 'runtime-a',
      },
      title: '优化后的标题',
    })

    expect(updated.runtimeWork?.projects[0].deviceWorkspaces[0].tasks).toEqual([
      expect.objectContaining({
        taskId: 'runtime-a',
        title: '优化后的标题',
        status: 'succeeded',
        running: false,
        threadStatus: 'idle',
        turnStatus: 'completed',
      }),
      expect.objectContaining({
        taskId: 'runtime-b',
        title: '不应变更',
        status: 'running',
        running: true,
      }),
    ])
  })

  test('updates pinned state across project and chat runtime task projections', () => {
    const projectTask = {
      taskId: 'project-thread',
      workspacePath: '/workspace/repo',
      title: 'Project task',
      runtime: 'codex' as const,
      pinned: false,
    }
    const chatTask = {
      taskId: 'chat-task',
      threadId: 'chat-thread',
      workspacePath: '/workspace/chat',
      title: 'Chat task',
      runtime: 'claude_code' as const,
      pinned: false,
    }
    const state = {
      ...initialWorkbenchState,
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              name: 'Repo',
              stateDeviceId: 'project-state-device',
            },
            deviceWorkspaces: [
              {
                deviceId: 'workspace-device',
                workspacePath: '/workspace/repo',
                available: true,
                tasks: [projectTask],
              },
            ],
            totalTasks: 1,
          },
        ],
        chats: [
          {
            deviceId: 'chat-device',
            workspacePath: '/workspace/chat',
            workspaceKind: 'chat',
            available: true,
            tasks: [chatTask],
          },
        ],
        totalTasks: 2,
      },
    }

    const projectUpdated = workbenchReducer(state, {
      type: 'runtime_task_pin_changed',
      deviceId: 'project-state-device',
      threadId: 'project-thread',
      pinned: true,
    })
    const chatUpdated = workbenchReducer(projectUpdated, {
      type: 'runtime_task_pin_changed',
      deviceId: 'chat-device',
      threadId: 'chat-thread',
      pinned: true,
    })

    expect(chatUpdated.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0].pinned).toBe(true)
    expect(chatUpdated.runtimeWork?.chats[0].tasks[0].pinned).toBe(true)
  })

  test('updates only the matching runtime task supervisor state', () => {
    const state = {
      ...initialWorkbenchState,
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
                    taskId: 'runtime-a',
                    workspacePath: '/workspace/repo',
                    title: 'Runtime A',
                    runtime: 'codex' as const,
                    status: 'succeeded',
                  },
                  {
                    taskId: 'runtime-b',
                    workspacePath: '/workspace/repo',
                    title: 'Runtime B',
                    runtime: 'codex' as const,
                    status: 'succeeded',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
    }
    const supervisor = {
      mode: 'auto' as const,
      status: 'active' as const,
      instructions: 'Keep the task focused',
      modelSelection: {
        modelName: 'supervisor-model',
        modelType: 'public',
      },
      intervalSeconds: 30,
      lastEvaluatedAt: 1786557741000,
      lastContentHash: 'latest',
      lastError: null,
      suggestions: [],
    }

    const updated = workbenchReducer(state, {
      type: 'runtime_task_supervisor_updated',
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        taskId: 'runtime-a',
      },
      supervisor,
    })

    expect(updated.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0].supervisor).toEqual(
      supervisor
    )
    expect(updated.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[1].supervisor).toBeUndefined()
  })

  test('updates a pinned project task through the project state device', () => {
    const state = {
      ...initialWorkbenchState,
      runtimeWork: {
        projects: [
          {
            project: {
              key: 'local:/workspace/repo',
              name: 'Repo',
              stateDeviceId: 'state-device',
            },
            deviceWorkspaces: [
              {
                deviceId: 'runtime-device',
                workspacePath: '/workspace/repo',
                available: true,
                tasks: [
                  {
                    taskId: 'runtime-a',
                    threadId: 'thread-a',
                    workspacePath: '/workspace/repo',
                    title: 'Runtime A',
                    runtime: 'codex' as const,
                    pinned: false,
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
    }

    const updated = workbenchReducer(state, {
      type: 'runtime_task_pinned_updated',
      request: {
        deviceId: 'state-device',
        threadId: 'thread-a',
        pinned: true,
      },
    })

    expect(updated.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0].pinned).toBe(true)
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
      { type: 'blank_chat_committed', standaloneChatKey: 4 }
    )

    expect(state.standaloneChatKey).toBe(5)
  })

  test('ignores a late blank chat commit after a newer draft scope is active', () => {
    const state = workbenchReducer(
      {
        ...initialWorkbenchState,
        standaloneChatKey: 5,
      },
      { type: 'blank_chat_committed', standaloneChatKey: 4 }
    )

    expect(state.standaloneChatKey).toBe(5)
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

  test('keeps resolved execution context when the route reopens the same task by identity', () => {
    const opened = workbenchReducer(
      {
        ...initialWorkbenchState,
        currentRuntimeTask: {
          deviceId: 'device-1',
          taskId: 'runtime-1',
          runtime: 'codex',
          threadId: 'thread-1',
          workspacePath: '/workspace/worktrees/runtime-1/repo',
          workspaceKind: 'worktree',
          worktreeId: 'runtime-1',
          projectSession: { projectId: 'project-1', issueId: 'issue-1' },
        },
      },
      {
        type: 'runtime_task_opened',
        address: {
          deviceId: 'device-1',
          taskId: 'runtime-1',
        },
        project: null,
      }
    )

    expect(opened.currentRuntimeTask).toEqual({
      deviceId: 'device-1',
      taskId: 'runtime-1',
      runtime: 'codex',
      threadId: 'thread-1',
      workspacePath: '/workspace/worktrees/runtime-1/repo',
      workspaceKind: 'worktree',
      worktreeId: 'runtime-1',
      projectSession: { projectId: 'project-1', issueId: 'issue-1' },
    })
  })

  test('keeps local Issue execution context when the route reopens the same task', () => {
    const opened = workbenchReducer(
      {
        ...initialWorkbenchState,
        currentRuntimeTask: {
          deviceId: 'device-1',
          taskId: 'runtime-1',
          runtime: 'codex',
          workspacePath: '/workspace/worktrees/runtime-1/repo',
          issueExecution: { projectId: 'project-1', issueId: 'issue-1' },
        },
      },
      {
        type: 'runtime_task_opened',
        address: {
          deviceId: 'device-1',
          taskId: 'runtime-1',
        },
        project: null,
      }
    )

    expect(opened.currentRuntimeTask).toEqual({
      deviceId: 'device-1',
      taskId: 'runtime-1',
      runtime: 'codex',
      workspacePath: '/workspace/worktrees/runtime-1/repo',
      issueExecution: { projectId: 'project-1', issueId: 'issue-1' },
    })
  })

  test('reconciles an accepted task address without depending on work-list projection', () => {
    const state = {
      ...initialWorkbenchState,
      currentRuntimeTask: {
        deviceId: 'device-1',
        taskId: 'runtime-1',
        runtimeHandle: {
          modelSelection: {
            modelName: 'local-model:luna',
            modelType: 'runtime',
            options: {},
          },
        },
      },
    }

    const reconciled = workbenchReducer(state, {
      type: 'runtime_task_address_reconciled',
      previousAddress: {
        deviceId: 'device-1',
        taskId: 'runtime-1',
      },
      address: {
        deviceId: 'device-1',
        taskId: 'runtime-1',
        workspacePath: '/workspace/worktrees/runtime-1/repo',
        runtimeHandle: {
          threadId: 'thread-1',
        },
      },
    })

    expect(reconciled.currentRuntimeTask).toEqual({
      deviceId: 'device-1',
      taskId: 'runtime-1',
      workspacePath: '/workspace/worktrees/runtime-1/repo',
      runtimeHandle: {
        modelSelection: {
          modelName: 'local-model:luna',
          modelType: 'runtime',
          options: {},
        },
        threadId: 'thread-1',
      },
    })
  })

  test('does not reconcile an accepted address after the user switches tasks', () => {
    const state = {
      ...initialWorkbenchState,
      currentRuntimeTask: {
        deviceId: 'device-1',
        taskId: 'runtime-2',
        workspacePath: '/workspace/current',
      },
    }

    const reconciled = workbenchReducer(state, {
      type: 'runtime_task_address_reconciled',
      previousAddress: {
        deviceId: 'device-1',
        taskId: 'runtime-1',
      },
      address: {
        deviceId: 'device-1',
        taskId: 'runtime-1',
        workspacePath: '/workspace/worktrees/runtime-1/repo',
      },
    })

    expect(reconciled).toBe(state)
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

  test.each(['bootstrapped', 'devices_refreshed'] as const)(
    '%s preserves the current account preferences and identity during navigation refresh',
    type => {
      const staleUser = { id: 7, user_name: 'Alice', email: 'alice@example.com' }
      const currentUser = {
        ...staleUser,
        preferences: {
          wework_new_chat_model_selection: {
            modelName: 'selected-model',
            modelType: 'runtime' as const,
          },
        },
      }
      const state = { ...initialWorkbenchState, user: currentUser, isBootstrapping: false }
      const refreshed = workbenchReducer(
        state,
        type === 'bootstrapped'
          ? { type, user: staleUser, devices: [], projects: [] }
          : { type, user: staleUser, devices: [] }
      )
      expect(refreshed.user?.preferences?.wework_new_chat_model_selection?.modelName).toBe(
        'selected-model'
      )
      expect(refreshed.user).toBe(currentUser)
    }
  )

  test.each(['device-uuid'])(
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
        workspacePath: '/Users/me/chat',
        runtimeHandle: {
          threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
        },
      })
    }
  )

  test('does not hydrate a pathless optimistic task from its base workspace', () => {
    const state = {
      ...initialWorkbenchState,
      currentRuntimeTask: {
        deviceId: 'device-1',
        taskId: 'task-1',
      },
    }

    const optimistic = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { id: 1, name: 'Project' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/project',
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'task-1',
                    workspacePath: '',
                    title: 'Queued Worktree',
                    runtime: 'codex',
                    status: 'queued',
                    optimistic: true,
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

    expect(optimistic.currentRuntimeTask).toEqual({
      deviceId: 'device-1',
      taskId: 'task-1',
    })

    const hydrated = workbenchReducer(optimistic, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { id: 1, name: 'Project' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/project',
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'task-1',
                    workspacePath: '/executor/worktrees/task-1/project',
                    title: 'Queued Worktree',
                    runtime: 'codex',
                    status: 'queued',
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

    expect(hydrated.currentRuntimeTask).toEqual({
      deviceId: 'device-1',
      taskId: 'task-1',
      workspacePath: '/executor/worktrees/task-1/project',
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

  test('accepts a completed executor snapshot over a fresh optimistic runtime task', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'runtime_task_optimistic_upserted',
      project: { id: 7, name: 'Repo', tasks: [] },
      workspace: {
        deviceId: 'cloud-device',
        workspacePath: '/workspace/repo',
        projectId: 7,
        available: true,
        mapped: true,
        tasks: [],
      },
      task: {
        taskId: 'claude-task',
        workspacePath: '/workspace/repo',
        title: 'Claude task',
        runtime: 'claude_code',
        running: true,
        status: 'running',
        optimistic: true,
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
                deviceId: 'cloud-device',
                workspacePath: '/workspace/repo',
                projectId: 7,
                available: true,
                mapped: true,
                tasks: [
                  {
                    taskId: 'claude-task',
                    workspacePath: '/workspace/repo',
                    title: 'Claude task',
                    runtime: 'claude_code',
                    running: false,
                    status: 'active',
                    completedAt: 1_786_686_568_931,
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

    expect(refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
      taskId: 'claude-task',
      running: false,
      status: 'done',
      turnStatus: 'completed',
      completedAt: 1_786_686_568_931,
    })
    expect(
      refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0].optimistic
    ).toBeUndefined()
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

  test('refreshes sidebar metadata without replacing a newer lifecycle projection', () => {
    const state = workbenchReducer(initialWorkbenchState, {
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
                tasks: [
                  {
                    taskId: 'completed-task',
                    workspacePath: '/workspace/repo',
                    title: 'Completed task',
                    runtime: 'codex',
                    running: false,
                    status: 'done',
                    completedAt: 200,
                    updatedAt: 200,
                    pinned: false,
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
                available: true,
                tasks: [
                  {
                    taskId: 'completed-task',
                    threadId: 'provider-thread',
                    workspacePath: '/workspace/repo',
                    title: 'Completed task',
                    runtime: 'codex',
                    running: false,
                    status: 'active',
                    updatedAt: 100,
                    pinned: true,
                    pinnedOrder: 0,
                    sidebarOrder: 3,
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

    expect(refreshed.runtimeWork?.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
      taskId: 'completed-task',
      threadId: 'provider-thread',
      status: 'done',
      completedAt: 200,
      pinned: true,
      pinnedOrder: 0,
      sidebarOrder: 3,
    })
  })
})
