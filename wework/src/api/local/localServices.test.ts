import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getLocalUser, LOCAL_USER } from './localSession'
import { createLocalAppServices } from './localServices'
import {
  clearLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'

const OFFICIAL_CODEX_MODEL_DEFINITIONS: Array<[string, string, string, string[]]> = [
  ['gpt-5.6-sol', 'GPT-5.6-Sol', 'low', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-5.6-terra', 'GPT-5.6-Terra', 'medium', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-5.6-luna', 'GPT-5.6-Luna', 'medium', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.5', 'GPT-5.5', 'medium', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4', 'GPT-5.4', 'medium', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4-mini', 'GPT-5.4-Mini', 'medium', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark', 'high', ['low', 'medium', 'high', 'xhigh']],
]

const OFFICIAL_CODEX_MODELS = OFFICIAL_CODEX_MODEL_DEFINITIONS.map(
  ([model, displayName, defaultReasoningEffort, efforts], index) => ({
    id: model,
    model,
    displayName,
    isDefault: index === 0,
    defaultReasoningEffort,
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
  })
)

describe('createLocalAppServices', () => {
  beforeEach(() => {
    localStorage.clear()
    clearLocalModelConfigs()
  })

  test('returns local bootstrap data without backend', async () => {
    saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      group: '本地推理',
      modelId: 'gpt-oss:20b',
      baseUrl: 'http://localhost:11434/v1',
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.models.list') {
        return {
          providers: [
            {
              id: 'openai',
              displayName: 'CodeX',
              type: 'official',
              current: true,
              available: true,
              error: null,
              data: OFFICIAL_CODEX_MODELS,
            },
          ],
          data: OFFICIAL_CODEX_MODELS,
        }
      }
      return { projects: [], chats: [], totalTasks: 0 }
    })
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
    const models = await services.modelApi.listModels()

    expect(models).toEqual({
      data: expect.arrayContaining([
        expect.objectContaining({
          name: 'gpt-5.5',
          type: 'runtime',
          modelId: 'gpt-5.5',
          runtime: { family: 'openai.openai-responses', provider: 'local' },
        }),
        expect.objectContaining({
          name: 'local-model:ollama',
          type: 'runtime',
          displayName: 'Ollama GPT',
          modelId: 'gpt-oss:20b',
          config: expect.objectContaining({
            ui: expect.objectContaining({
              family: 'model-interface:%E6%9C%AC%E5%9C%B0%E6%8E%A8%E7%90%86',
              familyLabel: '本地推理',
            }),
          }),
          runtime: { family: 'openai.openai-responses', provider: 'local' },
        }),
      ]),
    })
    const modelIds = models.data.map(model => model.modelId)
    expect(modelIds).not.toContain('Sol')
    expect(modelIds).not.toContain('Terra')
    expect(modelIds).not.toContain('Luna')
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
    const preferences = {
      wework_new_chat_model_selection: {
        modelName: 'gpt-5.5',
        modelType: 'runtime' as const,
        options: { collaborationMode: 'plan' },
      },
      wework_project_work_preferences: {
        'project:7': {
          executionMode: 'git_worktree' as const,
          worktreeBranch: 'feature/alpha',
        },
      },
    }
    await expect(services.userApi?.updateCurrentUser({ preferences })).resolves.toEqual({
      ...LOCAL_USER,
      preferences,
    })
    expect(getLocalUser().preferences).toEqual(preferences)
    await expect(services.runtimeWorkApi?.listRuntimeWork()).resolves.toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
    })
    expect(request).toHaveBeenCalledWith('runtime.tasks.list', {})
  })

  test('returns Codex provider models in local model list', async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.models.list') {
        return {
          providers: [
            {
              id: 'openai',
              displayName: 'CodeX',
              type: 'official',
              current: false,
              available: true,
              error: null,
              data: [],
            },
            {
              id: 'wecode-openai',
              displayName: 'wecode openai',
              type: 'provider',
              current: true,
              available: true,
              error: null,
              data: [
                {
                  id: 'Doubao-Seed-2.0-pro-260215',
                  model: 'Doubao-Seed-2.0-pro-260215',
                  displayName: 'Doubao Seed',
                  providerId: 'wecode-openai',
                  providerName: 'wecode openai',
                  providerType: 'provider',
                  providerCurrent: true,
                },
              ],
            },
          ],
          data: [
            {
              id: 'Doubao-Seed-2.0-pro-260215',
              model: 'Doubao-Seed-2.0-pro-260215',
              displayName: 'Doubao Seed',
              providerId: 'wecode-openai',
              providerName: 'wecode openai',
              providerType: 'provider',
              providerCurrent: true,
            },
          ],
        }
      }
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await expect(services.modelApi.listModels()).resolves.toEqual({
      data: expect.arrayContaining([
        expect.objectContaining({
          name: 'Doubao-Seed-2.0-pro-260215',
          type: 'runtime',
          displayName: 'Doubao-Seed-2.0-pro-260215',
          modelId: 'Doubao-Seed-2.0-pro-260215',
          config: expect.objectContaining({
            weworkModelKind: 'codex-provider',
            codexProviderId: 'wecode-openai',
            ui: expect.objectContaining({
              family: 'codex-provider:wecode-openai',
              familyLabel: 'wecode openai',
            }),
          }),
          runtime: { family: 'openai.openai-responses', provider: 'local' },
        }),
      ]),
    })
  })

  test('normalizes runtime handles returned by local executor task lists', async () => {
    const request = vi.fn().mockResolvedValue({
      workspaces: [
        {
          workspace_path: '/Users/me/project',
          tasks: [
            {
              taskId: 'local-visible-task',
              workspacePath: '/Users/me/project',
              title: 'Fix guidance',
              runtime: 'codex',
              runtimeHandle: {
                threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
                modelSelection: {
                  modelName: 'local-model:mimo',
                  modelType: 'runtime',
                  options: {
                    collaborationMode: 'plan',
                  },
                },
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
              tasks: [
                {
                  taskId: 'local-visible-task',
                  runtimeHandle: {
                    threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
                  },
                  modelSelection: {
                    modelName: 'local-model:mimo',
                    modelType: 'runtime',
                    options: {
                      collaborationMode: 'plan',
                    },
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
          tasks: [
            {
              taskId: 'newer-task',
              workspacePath: '/Users/me/project',
              title: 'Newer task',
              runtime: 'codex',
              createdAt: 1780000100000,
              updatedAt: 1780000120000,
            },
            {
              taskId: 'older-task',
              workspacePath: '/Users/me/project',
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
    const tasks = response?.projects[0].deviceWorkspaces[0].tasks

    expect(tasks?.map(task => task.taskId)).toEqual(['newer-task', 'older-task'])
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
          taskId: 'task-1',
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
      taskId: 'task-1',
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
          local_path: '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard.png',
          local_preview_url:
            '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard.png',
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
      taskId: 'task-1',
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
          local_path: '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard.png',
          local_preview_url:
            '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard.png',
        },
      ],
      executionRequest: expect.objectContaining({
        task_id: 'task-1',
        subtask_id: expect.any(String),
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
            subtask_id: expect.any(String),
            file_extension: '.png',
            local_path: '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard.png',
            local_preview_url:
              '/Users/me/.wegent-executor/workspace/attachments/draft/-45/clipboard.png',
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
        }
        if (method === 'runtime.worktrees.prepare') {
          const path = `/Users/me/.wegent-executor/workspace/worktrees/${data.worktreeId}/project`
          return { success: true, path, worktree: { path } }
        }
        if (method === 'runtime.tasks.create') {
          return {
            accepted: true,
            taskId: 'task-1',
            runtime: 'codex',
            runtimeHandle: {
              modelSelection: {
                modelName: 'local-model:mimo',
                modelType: 'runtime',
              },
            },
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
      taskId: 'task-1',
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
      /^\/Users\/me\/\.wegent-executor\/workspace\/worktrees\/runtime-\d+\/project$/
    )
    expect(response?.workspacePath).toBe(worktreePath)
    expect(response?.runtimeHandle).toEqual({
      modelSelection: {
        modelName: 'local-model:mimo',
        modelType: 'runtime',
      },
    })
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'git_is_worktree',
      args: ['/Users/me/project'],
      timeout_seconds: 15,
    })
    expect(request).toHaveBeenCalledWith('runtime.worktrees.prepare', {
      deviceId: 'device-uuid',
      sourcePath: '/Users/me/project',
      worktreeId: expect.stringMatching(/^runtime-\d+$/),
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
        }
        if (method === 'runtime.worktrees.prepare') {
          const path = `/Users/me/.wegent-executor/workspace/worktrees/${data.worktreeId}/project`
          return { success: true, path, worktree: { path } }
        }
        if (method === 'runtime.tasks.create') {
          return {
            accepted: true,
            taskId: 'task-1',
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
      taskId: 'task-1',
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
    expect(request).toHaveBeenCalledWith('runtime.worktrees.prepare', {
      deviceId: 'device-uuid',
      sourcePath: '/Users/me/project',
      worktreeId: expect.stringMatching(/^runtime-\d+$/),
      ref: 'develop',
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
        taskId: 'task-1',
      },
      message: 'continue',
      modelId: 'gpt-5.5',
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
          local_path: '/Users/me/.wegent-executor/workspace/attachments/draft/-46/follow-up.png',
          local_preview_url:
            '/Users/me/.wegent-executor/workspace/attachments/draft/-46/follow-up.png',
        },
      ],
    })

    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
    expect(sendPayload).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        address: {
          deviceId: 'device-uuid',
          workspacePath: '/Users/me/project',
          taskId: 'task-1',
        },
        message: 'continue',
        collaborationMode: 'default',
        modelOptions: {
          collaborationMode: 'default',
          reasoning: 'xhigh',
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
            local_path: '/Users/me/.wegent-executor/workspace/attachments/draft/-46/follow-up.png',
            local_preview_url:
              '/Users/me/.wegent-executor/workspace/attachments/draft/-46/follow-up.png',
          },
        ],
        executionRequest: expect.objectContaining({
          task_id: 'task-1',
          subtask_id: expect.any(String),
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
              effort: 'xhigh',
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
              subtask_id: expect.any(String),
              file_extension: '.png',
              local_path:
                '/Users/me/.wegent-executor/workspace/attachments/draft/-46/follow-up.png',
              local_preview_url:
                '/Users/me/.wegent-executor/workspace/attachments/draft/-46/follow-up.png',
            },
          ],
        }),
      })
    )
    expect(sendPayload).not.toHaveProperty('message_id')
    expect(sendPayload).not.toHaveProperty('modelId')
  })

  test('routes last user message edits through the local runtime rollback method', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.rollbackRuntimeTask({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'edited question',
      messageId: 'user-last',
      modelId: 'gpt-5.5',
      modelOptions: {
        collaborationMode: 'default',
        reasoning: 'high',
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.rollback')?.[1]
    expect(payload).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        address: {
          deviceId: 'device-uuid',
          workspacePath: '/Users/me/project',
          taskId: 'task-1',
        },
        message: 'edited question',
        messageId: 'user-last',
        collaborationMode: 'default',
        modelOptions: {
          collaborationMode: 'default',
          reasoning: 'high',
        },
        executionRequest: expect.objectContaining({
          task_id: 'task-1',
          subtask_id: expect.any(String),
          prompt: 'edited question',
          new_session: false,
          model_config: expect.objectContaining({
            model: 'openai',
            model_id: 'gpt-5.5',
            api_format: 'responses',
            protocol: 'openai-responses',
          }),
          project_workspace_path: '/Users/me/project',
        }),
      })
    )
    expect(payload).not.toHaveProperty('modelId')
  })

  test('uses local model settings for create and continue execution requests', async () => {
    saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      modelId: 'gpt-oss:20b',
      baseUrl: 'http://localhost:11434/v1',
      contextWindow: 128000,
    })
    saveLocalModelConfig({
      id: 'lmstudio',
      displayName: 'LM Studio',
      modelId: 'qwen3-coder',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'real-key',
      webSearchMode: 'cached',
      imageGenerationEnabled: true,
    })
    saveLocalModelConfig({
      id: 'custom',
      displayName: 'Custom Gateway',
      modelId: 'custom-model',
      baseUrl: 'http://localhost:9876/api',
      requestPath: '/respond',
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
      taskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'local-model:ollama',
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'continue',
      modelId: 'local-model:ollama',
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'secure continue',
      modelId: 'local-model:lmstudio',
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'custom continue',
      modelId: 'local-model:custom',
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
    const customModelConfig = sendPayloads[2].executionRequest.model_config

    expect(continueModelConfig).toEqual(createModelConfig)
    expect(createModelConfig).toEqual(
      expect.objectContaining({
        model: 'openai',
        model_id: 'gpt-oss:20b',
        api_format: 'responses',
        protocol: 'openai-responses',
        base_url: 'http://localhost:11434/v1',
        responses_url: 'http://localhost:11434/v1/responses',
        api_key: 'dummy',
        model_context_window: 128000,
        web_search: 'disabled',
        image_generation: false,
        codex_responses_compat_proxy: true,
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
        web_search: 'cached',
        image_generation: true,
        codex_responses_compat_proxy: true,
      })
    )
    expect(customModelConfig).toEqual(
      expect.objectContaining({
        model_id: 'custom-model',
        base_url: 'http://localhost:9876/api',
        responses_url: 'http://localhost:9876/api/respond',
        codex_responses_compat_proxy: true,
      })
    )
  })

  test('uses selected Codex provider for local runtime execution requests', async () => {
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
      taskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'Doubao-Seed-2.0-pro-260215',
      modelOptions: {
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
      },
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'continue',
      modelId: 'Doubao-Seed-2.0-pro-260215',
      modelOptions: {
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
      },
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]

    expect(createPayload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        model: 'openai',
        model_id: 'Doubao-Seed-2.0-pro-260215',
        api_format: 'responses',
        protocol: 'openai-responses',
        model_provider: 'wecode-openai',
        runtime_config: {
          codex: {
            use_user_config: true,
            configured: true,
          },
        },
      })
    )
    expect(createPayload.executionRequest.model_config).not.toHaveProperty('base_url')
    expect(createPayload.executionRequest.model_config).not.toHaveProperty('api_key')
    expect(sendPayload.executionRequest.model_config).toEqual(
      createPayload.executionRequest.model_config
    )
  })

  test('adds configured local proxy to local runtime execution requests', async () => {
    saveLocalProxyUrl('http://127.0.0.1:7890')
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
      taskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'gpt-5.5',
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const modelConfig = createPayload.executionRequest.model_config

    expect(modelConfig.proxy).toEqual({ url: 'http://127.0.0.1:7890' })
    expect(modelConfig.runtime_config.codex).toEqual(
      expect.objectContaining({
        use_user_config: true,
        configured: true,
        use_proxy: true,
        proxy_configured: true,
      })
    )
  })

  test('rejects missing local model config instead of falling back to built-in Codex', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await expect(
      services.runtimeWorkApi?.createRuntimeTask({
        teamId: 0,
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
        runtime: 'codex',
        message: 'hello',
        title: 'Hello',
        modelId: 'local-model:missing',
      })
    ).rejects.toThrow('Local model is no longer configured')
    expect(request).not.toHaveBeenCalledWith('runtime.tasks.create', expect.anything())
  })

  test('preserves request user input responses in local runtime send requests', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: { deviceId: 'local-device', taskId: 'task-1' },
      message: '工作目标',
      requestUserInputResponse: {
        requestId: 42,
        itemId: 'item-1',
        answers: {
          goal: { answers: ['工作目标'] },
        },
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
    expect(payload).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        address: { deviceId: 'device-uuid', taskId: 'task-1' },
        message: '工作目标',
        requestUserInputResponse: {
          requestId: 42,
          itemId: 'item-1',
          answers: {
            goal: { answers: ['工作目标'] },
          },
        },
        executionRequest: expect.objectContaining({
          task_id: 'task-1',
          subtask_id: expect.any(String),
          prompt: '工作目标',
          new_session: false,
          model_config: expect.objectContaining({
            model: 'openai',
            model_id: 'gpt-5.5',
            api_format: 'responses',
            protocol: 'openai-responses',
          }),
        }),
      })
    )
    expect(payload).not.toHaveProperty('message_id')
    expect(payload).not.toHaveProperty('modelId')
  })

  test('normalizes local runtime goal requests before IPC', async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      goal: {
        threadId: 'thread-1',
        objective: '实现 plan 里的功能',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1780000000000,
        updatedAt: 1780000000000,
      },
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await expect(
      services.runtimeWorkApi?.setRuntimeGoal({
        address: { deviceId: 'local-device', taskId: 'task-1' },
        objective: '实现 plan 里的功能',
        status: 'active',
        tokenBudget: null,
      })
    ).resolves.toMatchObject({
      accepted: true,
      goal: {
        threadId: 'thread-1',
        objective: '实现 plan 里的功能',
        status: 'active',
      },
    })

    expect(request).toHaveBeenCalledWith('runtime.tasks.goal.set', {
      address: { deviceId: 'device-uuid', taskId: 'task-1' },
      objective: '实现 plan 里的功能',
      status: 'active',
      tokenBudget: null,
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
          tasks: [
            {
              taskId: 'task-1',
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
          tasks: [
            {
              taskId: 'chat-1',
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
            kind: 'local',
            source: 'legacy_root',
            stateDeviceId: 'device-uuid',
            roots: [{ kind: 'local', path: '/Users/me/project' }],
            pinned: false,
            appearance: null,
          },
          deviceWorkspaces: [
            expect.objectContaining({
              deviceId: 'device-uuid',
              workspacePath: '/Users/me/project',
              workspaceKind: 'workspace',
              workspaceSource: 'local',
              label: 'Project',
              tasks: [
                expect.objectContaining({
                  taskId: 'task-1',
                  workspacePath: '/Users/me/worktrees/42/project',
                  workspaceKind: 'worktree',
                  worktreeId: '42',
                }),
              ],
            }),
          ],
          totalTasks: 1,
        },
      ],
      chats: [
        expect.objectContaining({
          deviceId: 'device-uuid',
          workspacePath: '/Users/me/chat',
          workspaceKind: 'chat',
          tasks: [
            expect.objectContaining({
              taskId: 'chat-1',
            }),
          ],
        }),
      ],
      totalTasks: 2,
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
              tasks: [
                {
                  task_id: 'task-1',
                  workspace_path: '/Users/me/worktrees/42/project',
                  title: 'Build',
                  runtime: 'codex',
                  workspace_kind: 'worktree',
                  worktree_id: '42',
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    const response = await services.runtimeWorkApi?.listRuntimeWork()
    const task = response?.projects[0].deviceWorkspaces[0].tasks[0]

    expect(task).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
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
          tasks: [
            {
              taskId: 'task-1',
              projectWorkspacePath: '/Users/me/worktrees/99/project',
              title: 'Build',
              runtime: 'codex',
              workspaceKind: 'worktree',
              worktreeId: '99',
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
        tasks: [
          expect.objectContaining({
            taskId: 'task-1',
            workspacePath: '/Users/me/worktrees/99/project',
            workspaceKind: 'worktree',
            worktreeId: '99',
          }),
        ],
      })
    )
  })

  test('drops empty remote workspace shells when a local workspace has the same label', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      workspaces: [
        {
          workspacePath: '/Users/me',
          label: 'me',
          workspaceSource: 'local',
          tasks: [
            {
              taskId: 'task-1',
              workspacePath: '/Users/me',
              title: 'Local task',
              runtime: 'codex',
            },
          ],
        },
        {
          workspacePath: '/home/me',
          label: 'me',
          workspaceSource: 'remote',
          remoteHostId: 'remote-ssh-codex-managed:host',
          tasks: [],
        },
      ],
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    const response = await services.runtimeWorkApi?.listRuntimeWork()

    expect(response?.projects.map(project => project.project.key)).toEqual(['local:/Users/me'])
    expect(response?.projects[0].deviceWorkspaces).toHaveLength(1)
    expect(response?.projects[0].deviceWorkspaces[0]).toEqual(
      expect.objectContaining({
        workspacePath: '/Users/me',
        workspaceSource: 'local',
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
