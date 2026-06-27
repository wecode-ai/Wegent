import { describe, expect, test, vi } from 'vitest'
import { LOCAL_USER } from './localSession'
import { createLocalAppServices } from './localServices'

describe('createLocalAppServices', () => {
  test('returns local bootstrap data without backend', async () => {
    const request = vi.fn().mockResolvedValue({ projects: [], chats: [], totalLocalTasks: 0 })
    const ensure = vi.fn().mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
      version: '1.9.0',
    })
    const services = createLocalAppServices({
      ensure,
      request,
      subscribe: vi.fn(),
    })

    await expect(services.teamApi.getDefaultWorkbenchTeam()).resolves.toMatchObject({
      id: 0,
      name: 'local-wework',
      is_active: true,
    })
    await expect(services.modelApi.listModels()).resolves.toEqual({
      data: [
        expect.objectContaining({
          name: 'codex-gpt-5.5',
          type: 'runtime',
          modelId: 'gpt-5.5',
          runtime: { family: 'openai.openai-responses', provider: 'local' },
        }),
      ],
    })
    await expect(services.deviceApi.listDevices()).resolves.toEqual([
      expect.objectContaining({
        device_id: 'local-device',
        name: 'Local Executor',
        status: 'online',
        device_type: 'local',
        executor_version: '1.9.0',
        bind_shell: 'claudecode',
      }),
    ])
    await expect(services.userApi?.updateCurrentUser({ preferences: {} })).resolves.toEqual(
      LOCAL_USER
    )
    await expect(services.runtimeWorkApi?.listRuntimeWork()).resolves.toEqual({
      projects: [],
      chats: [],
      totalLocalTasks: 0,
    })
    expect(request).toHaveBeenCalledWith('runtime.tasks.list', {})
  })

  test('keeps local device visible when executor startup fails', async () => {
    const services = createLocalAppServices({
      ensure: vi.fn().mockRejectedValue(new Error('sidecar missing')),
      request: vi.fn(),
      subscribe: vi.fn(),
    })

    await expect(services.deviceApi.listDevices()).resolves.toEqual([
      expect.objectContaining({
        device_id: 'local-device',
        name: 'Local Executor',
        status: 'offline',
        device_type: 'local',
        executor_version: '1.8.5',
        bind_shell: 'claudecode',
        error: 'sidecar missing',
      }),
    ])
  })

  test('routes runtime task creation and device commands through app ipc', async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.tasks.create') {
        return {
          accepted: true,
          deviceId: 'local-device',
          localTaskId: 'task-1',
          workspacePath: '/Users/me/project',
          runtime: 'codex',
        }
      }
      if (method === 'device.execute_command') {
        return { success: true, stdout: '/Users/me', stderr: '', exit_code: 0 }
      }
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      localTaskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'gpt-5',
      modelOptions: {
        reasoning: 'medium',
      },
      additionalSkills: [{ name: 'planner', namespace: 'default' }],
      execution: {
        workspace: {
          source: 'local_path',
          path: '/Users/me/project',
        },
      },
    })
    await services.deviceApi.executeCommand('local-device', {
      command_key: 'home_dir',
      timeout_seconds: 10,
    })

    expect(request).toHaveBeenCalledWith('runtime.tasks.create', {
      teamId: 0,
      deviceId: 'device-uuid',
      workspacePath: '/Users/me/project',
      localTaskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'gpt-5',
      modelOptions: {
        reasoning: 'medium',
      },
      additionalSkills: [{ name: 'planner', namespace: 'default' }],
      execution: {
        workspace: {
          source: 'local_path',
          path: '/Users/me/project',
        },
      },
      executionRequest: expect.objectContaining({
        task_id: expect.any(Number),
        subtask_id: expect.any(Number),
        team_id: 0,
        team_name: 'local-wework',
        task_title: 'Hello',
        subtask_title: 'Hello - Assistant',
        prompt: 'hello',
        model_config: expect.objectContaining({
          model: 'openai',
          model_id: 'gpt-5',
          api_format: 'responses',
          protocol: 'openai-responses',
          runtime_config: {
            codex: {
              use_user_config: true,
              configured: true,
            },
          },
          reasoning: {
            effort: 'medium',
          },
        }),
        workspace: {
          project: {
            source: 'local_path',
            path: '/Users/me/project',
          },
        },
        device_id: 'device-uuid',
        execution_target_type: 'local',
        workspace_source: 'local_path',
        project_workspace_path: '/Users/me/project',
        new_session: true,
        skill_names: ['planner'],
        preload_skills: [{ name: 'planner', namespace: 'default' }],
        user_selected_skills: [{ name: 'planner', namespace: 'default' }],
      }),
    })
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'home_dir',
      timeout_seconds: 10,
    })
  })

  test('rejects local runtime task creation without a workspace path', async () => {
    const request = vi.fn()
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await expect(
      services.runtimeWorkApi?.createRuntimeTask({
        teamId: 0,
        deviceId: 'local-device',
        runtime: 'codex',
        message: 'hello',
      })
    ).rejects.toThrow('workspacePath is required')
    expect(request).not.toHaveBeenCalled()
  })

  test('normalizes legacy local runtime task addresses to the ready device id', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: { deviceId: 'local-device', localTaskId: 'task-1' },
      message: 'continue',
    })

    expect(request).toHaveBeenCalledWith('runtime.tasks.send', {
      address: { deviceId: 'device-uuid', localTaskId: 'task-1' },
      message: 'continue',
    })
  })

  test('adapts executor runtime workspace list to workbench shape', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      workspaces: [
        {
          workspacePath: '/Users/me/project',
          label: 'Project',
          workspaceSource: 'local',
          localTasks: [
            {
              localTaskId: 'task-1',
              workspace_path: '/Users/me/worktrees/42/project',
              title: 'Build',
              runtime: 'codex',
              workspace_kind: 'worktree',
              worktree_id: '42',
            },
          ],
        },
        {
          workspacePath: '/Users/me/chat',
          localTasks: [
            {
              localTaskId: 'chat-1',
              workspacePath: '/Users/me/chat',
              title: 'Chat',
              runtime: 'codex',
              workspaceKind: 'chat',
            },
          ],
        },
      ],
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await expect(services.runtimeWorkApi?.listRuntimeWork()).resolves.toEqual({
      projects: [
        {
          project: {
            key: 'local:/Users/me/project',
            id: expect.any(Number),
            name: 'Project',
          },
          deviceWorkspaces: [
            expect.objectContaining({
              deviceId: 'device-uuid',
              workspacePath: '/Users/me/project',
              workspaceKind: 'workspace',
              workspaceSource: 'local',
              label: 'Project',
              localTasks: [
                expect.objectContaining({
                  localTaskId: 'task-1',
                  workspacePath: '/Users/me/worktrees/42/project',
                  workspaceKind: 'worktree',
                  worktreeId: '42',
                }),
              ],
            }),
          ],
          totalLocalTasks: 1,
        },
      ],
      chats: [
        expect.objectContaining({
          deviceId: 'device-uuid',
          workspacePath: '/Users/me/chat',
          workspaceKind: 'chat',
          localTasks: [
            expect.objectContaining({
              localTaskId: 'chat-1',
            }),
          ],
        }),
      ],
      totalLocalTasks: 2,
    })
  })

  test('normalizes app-shaped runtime task worktree fields', async () => {
    const request = vi.fn().mockResolvedValue({
      projects: [
        {
          project: { key: 'local:/Users/me/project', id: 7, name: 'Project' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              deviceName: 'Local Executor',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/Users/me/project',
              localTasks: [
                {
                  local_task_id: 'task-1',
                  workspace_path: '/Users/me/worktrees/42/project',
                  title: 'Build',
                  runtime: 'codex',
                  workspace_kind: 'worktree',
                  worktree_id: '42',
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        },
      ],
      chats: [],
      totalLocalTasks: 1,
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    const response = await services.runtimeWorkApi?.listRuntimeWork()
    const task = response?.projects[0].deviceWorkspaces[0].localTasks[0]

    expect(task).toEqual(
      expect.objectContaining({
        localTaskId: 'task-1',
        workspacePath: '/Users/me/worktrees/42/project',
        workspaceKind: 'worktree',
        worktreeId: '42',
      })
    )
  })

  test('adapts map-shaped executor runtime workspace list', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      workspaces: {
        '/Users/me/project': {
          label: 'Project',
          local_tasks: [
            {
              local_task_id: 'task-1',
              project_workspace_path: '/Users/me/worktrees/99/project',
              title: 'Build',
              runtime: 'codex',
              workspace_kind: 'worktree',
              worktree_id: '99',
            },
          ],
        },
      },
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    const response = await services.runtimeWorkApi?.listRuntimeWork()

    expect(response?.projects[0].deviceWorkspaces[0]).toEqual(
      expect.objectContaining({
        deviceId: 'device-uuid',
        workspacePath: '/Users/me/project',
        workspaceKind: 'workspace',
        localTasks: [
          expect.objectContaining({
            localTaskId: 'task-1',
            workspacePath: '/Users/me/worktrees/99/project',
            workspaceKind: 'worktree',
            worktreeId: '99',
          }),
        ],
      })
    )
  })

  test('routes workspace file APIs through local executor commands', async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method !== 'device.execute_command') return {}
        if (data.command_key === 'workspace_tree') {
          return {
            success: true,
            stdout: {
              path: '/Users/me/project',
              entries: [
                {
                  name: 'src',
                  path: '/Users/me/project/src',
                  is_directory: true,
                  size: 0,
                  modified_at: '2026-06-20T01:00:00Z',
                },
              ],
            },
            stderr: '',
            exit_code: 0,
          }
        }
        if (data.command_key === 'workspace_read_text_file') {
          return {
            success: true,
            stdout: {
              path: '/Users/me/project/README.md',
              name: 'README.md',
              content: 'hello',
              truncated: false,
              size: 5,
              modified_at: '2026-06-20T01:00:00Z',
            },
            stderr: '',
            exit_code: 0,
          }
        }
        return { success: false, error: 'unexpected command', stderr: '', exit_code: 1 }
      })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await expect(
      services.deviceApi.listWorkspaceEntries('local-device', '/Users/me/project')
    ).resolves.toEqual({
      path: '/Users/me/project',
      entries: [
        {
          name: 'src',
          path: '/Users/me/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: '2026-06-20T01:00:00Z',
        },
      ],
    })
    await expect(
      services.deviceApi.readWorkspaceTextFile('local-device', '/Users/me/project/README.md')
    ).resolves.toEqual({
      path: '/Users/me/project/README.md',
      name: 'README.md',
      content: 'hello',
      truncated: false,
      size: 5,
      modifiedAt: '2026-06-20T01:00:00Z',
    })

    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'workspace_tree',
      path: '/Users/me/project',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 512,
    })
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'workspace_read_text_file',
      path: '/Users/me/project',
      args: ['README.md'],
      timeout_seconds: 15,
      max_output_bytes: 1024 * 1024 * 2,
    })
  })
})
