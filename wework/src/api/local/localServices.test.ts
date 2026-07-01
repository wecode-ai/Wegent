import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LOCAL_USER } from './localSession'
import { createLocalAppServices } from './localServices'
import {
  clearLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'

describe('createLocalAppServices', () => {
  beforeEach(() => {
    clearLocalModelConfigs()
  })

  test('returns local bootstrap data without backend', async () => {
    saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      modelId: 'gpt-oss:20b',
      baseUrl: 'http://localhost:11434/v1',
    })
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
        expect.objectContaining({
          name: 'local-model:ollama',
          type: 'runtime',
          displayName: 'Ollama GPT',
          modelId: 'gpt-oss:20b',
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

  test('normalizes runtime handles returned by local executor task lists', async () => {
    const request = vi.fn().mockResolvedValue({
      workspaces: [
        {
          workspace_path: '/Users/me/project',
          local_tasks: [
            {
              local_task_id: 'local-visible-task',
              workspace_path: '/Users/me/project',
              title: 'Fix guidance',
              runtime: 'codex',
              runtime_handle: {
                threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
              },
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

    await expect(services.runtimeWorkApi?.listRuntimeWork()).resolves.toMatchObject({
      projects: [
        {
          deviceWorkspaces: [
            {
              localTasks: [
                {
                  localTaskId: 'local-visible-task',
                  runtimeHandle: {
                    threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
                  },
                },
              ],
            },
          ],
        },
      ],
    })
  })

  test('preserves numeric runtime task timestamps from local executor lists', async () => {
    const request = vi.fn().mockResolvedValue({
      workspaces: [
        {
          workspace_path: '/Users/me/project',
          local_tasks: [
            {
              local_task_id: 'newer-task',
              workspace_path: '/Users/me/project',
              title: 'Newer task',
              runtime: 'codex',
              createdAt: 1780000100000,
              updatedAt: 1780000120000,
            },
            {
              local_task_id: 'older-task',
              workspace_path: '/Users/me/project',
              title: 'Older task',
              runtime: 'codex',
              created_at: 1780000000000,
              updated_at: 1780000060000,
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

    const response = await services.runtimeWorkApi?.listRuntimeWork()
    const tasks = response?.projects[0].deviceWorkspaces[0].localTasks

    expect(tasks?.map(task => task.localTaskId)).toEqual(['newer-task', 'older-task'])
    expect(tasks?.[0]).toMatchObject({
      createdAt: 1780000100000,
      updatedAt: 1780000120000,
    })
    expect(tasks?.[1]).toMatchObject({
      createdAt: 1780000000000,
      updatedAt: 1780000060000,
    })
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
        collaborationMode: 'plan',
      },
      collaborationMode: 'plan',
      additionalSkills: [{ name: 'planner', namespace: 'default' }],
      attachments: [
        {
          id: -45,
          filename: 'clipboard.png',
          file_size: 1200,
          mime_type: 'image/png',
          status: 'ready',
          file_extension: '.png',
          created_at: '2026-06-29T00:00:00.000Z',
          local_path: '/Users/me/project/.wegent/attachments/draft/-45/clipboard.png',
          local_preview_url: '/Users/me/project/.wegent/attachments/draft/-45/clipboard.png',
        },
      ],
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
        collaborationMode: 'plan',
      },
      collaborationMode: 'plan',
      additionalSkills: [{ name: 'planner', namespace: 'default' }],
      attachments: [
        {
          id: -45,
          filename: 'clipboard.png',
          file_size: 1200,
          mime_type: 'image/png',
          status: 'ready',
          file_extension: '.png',
          created_at: '2026-06-29T00:00:00.000Z',
          local_path: '/Users/me/project/.wegent/attachments/draft/-45/clipboard.png',
          local_preview_url: '/Users/me/project/.wegent/attachments/draft/-45/clipboard.png',
        },
      ],
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
        collaborationMode: 'plan',
        skill_names: ['planner'],
        preload_skills: [{ name: 'planner', namespace: 'default' }],
        user_selected_skills: [{ name: 'planner', namespace: 'default' }],
        attachments: [
          {
            id: -45,
            filename: 'clipboard.png',
            original_filename: 'clipboard.png',
            file_size: 1200,
            mime_type: 'image/png',
            subtask_id: expect.any(Number),
            file_extension: '.png',
            local_path: '/Users/me/project/.wegent/attachments/draft/-45/clipboard.png',
            local_preview_url: '/Users/me/project/.wegent/attachments/draft/-45/clipboard.png',
          },
        ],
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

  test('creates a git worktree from the current branch before creating a local runtime task', async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method === 'device.execute_command') {
          if (data.command_key === 'git_is_worktree') {
            return { success: true, stdout: 'true', stderr: '', exit_code: 0 }
          }
          if (data.command_key === 'project_workspace_root') {
            return {
              success: true,
              stdout: '/Users/me/.wegent-executor/workspace/projects',
              stderr: '',
              exit_code: 0,
            }
          }
          if (data.command_key === 'git_worktree_add') {
            return { success: true, stdout: '', stderr: '', exit_code: 0 }
          }
        }
        if (method === 'runtime.tasks.create') {
          return {
            accepted: true,
            localTaskId: 'task-1',
            runtime: 'codex',
          }
        }
        return {}
      })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    const response = await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      localTaskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      execution: {
        workspace: {
          source: 'git_worktree',
        },
      },
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const worktreePath = String(createPayload.workspacePath)
    expect(worktreePath).toMatch(
      /^\/Users\/me\/\.wegent-executor\/workspace\/worktrees\/\d+\/project$/
    )
    expect(response?.workspacePath).toBe(worktreePath)
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'git_is_worktree',
      args: ['/Users/me/project'],
      timeout_seconds: 15,
    })
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'git_worktree_add',
      args: ['/Users/me/project', worktreePath],
      timeout_seconds: 120,
      max_output_bytes: 1024 * 1024,
    })
    expect(createPayload).toEqual(
      expect.objectContaining({
        deviceId: 'device-uuid',
        workspacePath: worktreePath,
        execution: {
          workspace: {
            source: 'git_worktree',
            path: worktreePath,
          },
        },
        executionRequest: expect.objectContaining({
          workspace_source: 'git_worktree',
          project_workspace_path: worktreePath,
          workspace: {
            project: {
              source: 'git_worktree',
              path: worktreePath,
            },
          },
        }),
      })
    )
  })

  test('passes an explicit worktree branch when creating a local runtime task', async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method === 'device.execute_command') {
          if (data.command_key === 'git_is_worktree') {
            return { success: true, stdout: 'true', stderr: '', exit_code: 0 }
          }
          if (data.command_key === 'project_workspace_root') {
            return {
              success: true,
              stdout: '/Users/me/.wegent-executor/workspace/projects',
              stderr: '',
              exit_code: 0,
            }
          }
          if (data.command_key === 'git_worktree_add') {
            return { success: true, stdout: '', stderr: '', exit_code: 0 }
          }
        }
        if (method === 'runtime.tasks.create') {
          return {
            accepted: true,
            localTaskId: 'task-1',
            runtime: 'codex',
          }
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
      execution: {
        workspace: {
          source: 'git_worktree',
          branch: 'develop',
        },
      },
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const worktreePath = String(createPayload.workspacePath)
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'git_worktree_add',
      args: ['/Users/me/project', worktreePath, 'develop'],
      timeout_seconds: 120,
      max_output_bytes: 1024 * 1024,
    })
    expect(createPayload).toEqual(
      expect.objectContaining({
        execution: {
          workspace: {
            source: 'git_worktree',
            path: worktreePath,
            branch: 'develop',
          },
        },
        executionRequest: expect.objectContaining({
          workspace: {
            project: {
              source: 'git_worktree',
              path: worktreePath,
              branch: 'develop',
            },
          },
        }),
      })
    )
  })

  test('builds the shared execution request for local runtime sends', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        localTaskId: 'task-1',
      },
      message: 'continue',
      modelId: 'codex-gpt-5.5',
      modelOptions: {
        collaborationMode: 'default',
        reasoning: 'extra_high',
        summary: 'concise',
        speed: 'fast',
      },
      attachments: [
        {
          id: -46,
          filename: 'follow-up.png',
          file_size: 640,
          mime_type: 'image/png',
          status: 'ready',
          file_extension: '.png',
          created_at: '2026-06-29T00:00:00.000Z',
          local_path: '/Users/me/project/.wegent/attachments/draft/-46/follow-up.png',
          local_preview_url: '/Users/me/project/.wegent/attachments/draft/-46/follow-up.png',
        },
      ],
    })

    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
    expect(sendPayload).toEqual(
      expect.objectContaining({
        address: {
          deviceId: 'device-uuid',
          workspacePath: '/Users/me/project',
          localTaskId: 'task-1',
        },
        message: 'continue',
        message_id: expect.any(Number),
        collaborationMode: 'default',
        modelOptions: {
          collaborationMode: 'default',
          reasoning: 'extra_high',
          summary: 'concise',
          speed: 'fast',
        },
        attachments: [
          {
            id: -46,
            filename: 'follow-up.png',
            file_size: 640,
            mime_type: 'image/png',
            status: 'ready',
            file_extension: '.png',
            created_at: '2026-06-29T00:00:00.000Z',
            local_path: '/Users/me/project/.wegent/attachments/draft/-46/follow-up.png',
            local_preview_url: '/Users/me/project/.wegent/attachments/draft/-46/follow-up.png',
          },
        ],
        executionRequest: expect.objectContaining({
          prompt: 'continue',
          model_config: expect.objectContaining({
            model: 'openai',
            model_id: 'gpt-5.5',
            api_format: 'responses',
            protocol: 'openai-responses',
            runtime_config: {
              codex: {
                use_user_config: true,
                configured: true,
              },
            },
            reasoning: {
              effort: 'extra_high',
              summary: 'concise',
            },
            service_tier: 'fast',
          }),
          project_workspace_path: '/Users/me/project',
          workspace: {
            project: {
              source: 'local_path',
              path: '/Users/me/project',
            },
          },
          device_id: 'device-uuid',
          execution_target_type: 'local',
          workspace_source: 'local_path',
          new_session: false,
          collaborationMode: 'default',
          attachments: [
            {
              id: -46,
              filename: 'follow-up.png',
              original_filename: 'follow-up.png',
              file_size: 640,
              mime_type: 'image/png',
              subtask_id: expect.any(Number),
              file_extension: '.png',
              local_path: '/Users/me/project/.wegent/attachments/draft/-46/follow-up.png',
              local_preview_url: '/Users/me/project/.wegent/attachments/draft/-46/follow-up.png',
            },
          ],
        }),
      })
    )
    expect(sendPayload).not.toHaveProperty('modelId')
  })

  test('uses local model settings for create and continue execution requests', async () => {
    saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      modelId: 'gpt-oss:20b',
      baseUrl: 'http://localhost:11434/v1',
    })
    saveLocalModelConfig({
      id: 'lmstudio',
      displayName: 'LM Studio',
      modelId: 'qwen3-coder',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'real-key',
    })
    const request = vi.fn().mockResolvedValue({ accepted: true })
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
      modelId: 'local-model:ollama',
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        localTaskId: 'task-1',
      },
      message: 'continue',
      modelId: 'local-model:ollama',
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        localTaskId: 'task-1',
      },
      message: 'secure continue',
      modelId: 'local-model:lmstudio',
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const sendPayloads = request.mock.calls
      .filter(([method]) => method === 'runtime.tasks.send')
      .map(([, payload]) => payload)
    const createModelConfig = createPayload.executionRequest.model_config
    const continueModelConfig = sendPayloads[0].executionRequest.model_config
    const keyedModelConfig = sendPayloads[1].executionRequest.model_config

    expect(continueModelConfig).toEqual(createModelConfig)
    expect(createModelConfig).toEqual(
      expect.objectContaining({
        model: 'openai',
        model_id: 'gpt-oss:20b',
        api_format: 'responses',
        protocol: 'openai-responses',
        base_url: 'http://localhost:11434/v1',
        api_key: 'dummy',
        runtime_config: {
          codex: {
            use_user_config: false,
            configured: false,
          },
        },
      })
    )
    expect(keyedModelConfig).toEqual(
      expect.objectContaining({
        model_id: 'qwen3-coder',
        base_url: 'http://localhost:1234/v1',
        api_key: 'real-key',
      })
    )
  })

  test('preserves request user input responses in local runtime send requests', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: { deviceId: 'local-device', localTaskId: 'task-1' },
      message: '工作目标',
      requestUserInputResponse: {
        requestId: 42,
        itemId: 'item-1',
        answers: {
          goal: { answers: ['工作目标'] },
        },
      },
    })

    expect(request).toHaveBeenCalledWith('runtime.tasks.send', {
      address: { deviceId: 'device-uuid', localTaskId: 'task-1' },
      message: '工作目标',
      message_id: expect.any(Number),
      requestUserInputResponse: {
        requestId: 42,
        itemId: 'item-1',
        answers: {
          goal: { answers: ['工作目标'] },
        },
      },
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

  test('routes local project archive requests with decoded workspace path', async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
      results: [],
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.archiveProjectConversations({
      runtimeProjectKey: 'local:/Users/me/project',
    })

    expect(request).toHaveBeenCalledWith('runtime.archived_conversations.archive_project', {
      runtimeProjectKey: 'local:/Users/me/project',
      workspacePath: '/Users/me/project',
    })
  })

  test('passes non-local runtime project keys through for executor resolution', async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
      results: [],
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.archiveProjectConversations({
      runtimeProjectKey: 'remote-project-1',
    })

    expect(request).toHaveBeenCalledWith('runtime.archived_conversations.archive_project', {
      runtimeProjectKey: 'remote-project-1',
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
