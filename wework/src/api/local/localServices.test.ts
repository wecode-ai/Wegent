import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getLocalUser, LOCAL_USER } from './localSession'
import {
  createAutomationApiFromIpc,
  createLocalAppServices,
  createRuntimeWorkApiFromIpc,
} from './localServices'
import {
  clearLocalModelConfigs,
  findLocalModelConfigByModelName,
  listLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import type { TurnFileChangesSummary } from '@/types/api'

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
      catalogReady: true,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'device.execute_command') {
        return {
          success: true,
          stdout: { exists: true },
          stderr: '',
          error: null,
        }
      }
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

    expect(request).toHaveBeenCalledWith('runtime.codex.models.list', {
      includeHidden: true,
    })
    expect(models).toEqual({
      data: expect.arrayContaining([
        expect.objectContaining({
          name: 'gpt-5.6-sol',
          type: 'runtime',
          modelId: 'gpt-5.6-sol',
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
              reasoningEfforts: [],
            }),
          }),
          runtime: { family: 'openai.openai-responses', provider: 'local' },
        }),
      ]),
    })
    const modelIds = models.data.map(model => model.modelId)
    expect(modelIds).toEqual(
      expect.arrayContaining([
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex-spark',
      ])
    )
    expect(modelIds).not.toContain('gpt-5.2')
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
        modelName: 'gpt-5.4',
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

  test('registers harness models through the executor Messages proxy', async () => {
    const config = saveLocalModelConfig({
      id: 'harness-model',
      displayName: 'Harness Model',
      modelId: 'upstream-model',
      baseUrl: 'https://models.example.com/v1',
      apiFormat: 'openai-chat-completions',
      requestPath: '/chat/completions',
      apiKey: 'provider-secret',
      catalogReady: false,
    })
    saveLocalProxyUrl('socks5://127.0.0.1:7890')
    const request = vi.fn().mockImplementation(async method => {
      if (method === 'runtime.harness_proxy.register') {
        return {
          token: 'proxy-token',
          baseUrl: 'http://127.0.0.1:1234/v1/harness-router/proxy-token',
        }
      }
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
      }),
      request,
      subscribe: vi.fn(),
    })

    const launch = await services.localHarnessModelApi?.resolveLaunch('opencode', {
      key: 'local',
      label: 'Harness Model',
      source: 'local',
      model: {
        name: `local-model:${config.id}`,
        type: 'runtime',
        provider: 'local',
        displayName: 'Harness Model',
        modelId: 'upstream-model',
        config: { weworkModelKind: 'model-interface' },
      },
    })

    expect(request).toHaveBeenCalledWith(
      'runtime.harness_proxy.register',
      expect.objectContaining({
        scope: expect.stringMatching(/^harness:opencode:/),
        upstream: {
          base_url: 'https://models.example.com/v1',
          request_url: 'https://models.example.com/v1/chat/completions',
          api_format: 'openai-chat-completions',
          convert_custom_tools: true,
          native_tool_search: false,
          native_namespace_tools: false,
          api_key: 'provider-secret',
          default_headers: [],
          proxy_url: 'socks5://127.0.0.1:7890',
          model_id: 'upstream-model',
          routing_model_id: null,
          max_output_tokens: null,
        },
      })
    )
    expect(launch).toMatchObject({
      modelId: 'wework-messages/wework-selected',
      proxyToken: 'proxy-token',
    })
    expect(launch?.env.OPENCODE_CONFIG_CONTENT).not.toContain('provider-secret')
    expect(launch?.env.OPENCODE_CONFIG_CONTENT).not.toContain('socks5://')

    const secondConfig = saveLocalModelConfig({
      id: 'second-harness-model',
      displayName: 'Second Harness Model',
      modelId: 'second-upstream-model',
      baseUrl: 'https://second-model.example.com/v1',
      apiFormat: 'anthropic-messages',
      requestPath: '/messages',
      apiKey: 'second-provider-secret',
      catalogReady: false,
    })
    const secondLaunch = await services.localHarnessModelApi?.resolveLaunch('claude_code', {
      key: 'second-local',
      label: 'Second Harness Model',
      source: 'local',
      model: {
        name: `local-model:${secondConfig.id}`,
        type: 'runtime',
        provider: 'local',
        displayName: 'Second Harness Model',
        modelId: 'second-upstream-model',
        config: { weworkModelKind: 'model-interface' },
      },
    })

    expect(request).toHaveBeenLastCalledWith(
      'runtime.harness_proxy.register',
      expect.objectContaining({
        scope: expect.stringMatching(/^harness:claude_code:/),
        upstream: expect.objectContaining({
          request_url: 'https://second-model.example.com/v1/messages',
          api_format: 'anthropic-messages',
          api_key: 'second-provider-secret',
          model_id: 'second-upstream-model',
        }),
      })
    )
    expect(secondLaunch).toMatchObject({
      modelId: 'wework-selected',
      proxyToken: 'proxy-token',
    })
    expect(secondLaunch?.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'second-provider-secret' })
    )
  })

  test('registers user and model context for DeepSeek Harness launches', async () => {
    const config = saveLocalModelConfig({
      id: 'context-model',
      displayName: 'Context Model',
      modelId: 'context-upstream-model',
      baseUrl: 'https://models.example.com/v1',
      apiFormat: 'openai-chat-completions',
      requestPath: '/chat/completions',
      apiKey: 'provider-secret',
      catalogReady: false,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.harness_proxy.register') {
        return {
          token: 'proxy-token',
          baseUrl: 'http://127.0.0.1:1234/v1/harness-router/proxy-token',
        }
      }
      if (method === 'runtime.harness_context.register') {
        return {
          token: 'context-token',
          baseUrl: 'http://127.0.0.1:1234/v1/harness-context/context-token',
        }
      }
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
      }),
      request,
      subscribe: vi.fn(),
      user: {
        id: 7,
        user_name: 'cloud-user',
        email: 'cloud@example.com',
      },
      cloudModelGateway: {
        baseUrl: 'https://api.example.com/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-token',
      },
    })

    const launch = await services.localHarnessModelApi?.resolveLaunch('opencode', {
      key: 'context-model',
      label: 'Context Model',
      source: 'local',
      model: {
        name: 'local-model:' + config.id,
        type: 'runtime',
        provider: 'local',
        displayName: 'Context Model',
        modelId: 'context-upstream-model',
        config: { weworkModelKind: 'model-interface' },
      },
    })

    expect(request).toHaveBeenCalledWith(
      'runtime.harness_context.register',
      expect.objectContaining({
        scope: expect.stringMatching(/^harness:opencode:/),
        user: {
          id: 7,
          userName: 'cloud-user',
          displayName: 'cloud-user',
          email: 'cloud@example.com',
          mode: 'cloud',
        },
        model: expect.objectContaining({
          runtimeModelId: 'context-upstream-model',
          displayName: 'Context Model',
          modelType: 'runtime',
        }),
      })
    )
    expect(launch).toMatchObject({
      context: {
        token: 'context-token',
        baseUrl: 'http://127.0.0.1:1234/v1/harness-context/context-token',
      },
    })
    const contextCall = request.mock.calls.find(
      ([method]) => method === 'runtime.harness_context.register'
    )
    expect(JSON.stringify(contextCall)).not.toContain('cloud-token')
    expect(JSON.stringify(contextCall)).not.toContain('provider-secret')
  })

  test('does not expose a custom model until its catalog restart is applied', async () => {
    saveLocalModelConfig({
      id: 'pending-model',
      displayName: 'Pending model',
      modelId: 'pending-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: false,
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
        version: '1.9.0',
      }),
      request: vi.fn().mockResolvedValue({
        providers: [],
        data: OFFICIAL_CODEX_MODELS,
      }),
      subscribe: vi.fn(),
    })

    const models = await services.modelApi.listModels()

    expect(models.data).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'local-model:pending-model' })])
    )
  })

  test('isolates catalog reconciliation failures and throttles retries', async () => {
    const catalogEntry = createDefaultLocalModelCatalogEntry({
      id: 'pending-model',
      displayName: 'Pending model',
      toolProfile: 'native',
    })
    saveLocalModelConfig({
      id: 'pending-model',
      displayName: 'Pending model',
      modelId: 'pending-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogEntry,
      codexCatalogModelId: String(catalogEntry.slug),
      catalogReady: false,
    })
    const request = vi.fn().mockRejectedValue(new Error('catalog unavailable'))
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
        version: '1.9.0',
        runtimeInstanceId: 'runtime-1',
      }),
      request,
      subscribe: vi.fn(),
    })

    await expect(services.deviceApi.listDevices()).resolves.toHaveLength(1)
    await expect(services.deviceApi.listDevices()).resolves.toHaveLength(1)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('runtime.codex.catalog.custom.write', {
      models: [expect.objectContaining({ slug: catalogEntry.slug })],
    })
  })

  test('deduplicates catalog reconciliation across local service instances', async () => {
    const catalogEntry = createDefaultLocalModelCatalogEntry({
      id: 'pending-model',
      displayName: 'Pending model',
      toolProfile: 'native',
    })
    saveLocalModelConfig({
      id: 'pending-model',
      displayName: 'Pending model',
      modelId: 'pending-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogEntry,
      codexCatalogModelId: String(catalogEntry.slug),
      catalogReady: false,
    })
    let resolveRestart: ((value: { restarted: boolean }) => void) | undefined
    const restart = new Promise<{ restarted: boolean }>(resolve => {
      resolveRestart = resolve
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return restart
      return {}
    })
    const ensure = vi.fn().mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
      version: '1.9.0',
      runtimeInstanceId: 'runtime-1',
    })
    const firstServices = createLocalAppServices({ ensure, request, subscribe: vi.fn() })
    const secondServices = createLocalAppServices({ ensure, request, subscribe: vi.fn() })

    const firstDevices = firstServices.deviceApi.listDevices()
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('runtime.codex.app_server.restart', { ifIdle: true })
    )
    const secondDevices = secondServices.deviceApi.listDevices()
    let secondResolved = false
    void secondDevices.then(() => {
      secondResolved = true
    })
    await Promise.resolve()

    expect(
      request.mock.calls.filter(([method]) => method === 'runtime.codex.catalog.custom.write')
    ).toHaveLength(1)
    expect(
      request.mock.calls.filter(([method]) => method === 'runtime.codex.app_server.restart')
    ).toHaveLength(1)
    expect(secondResolved).toBe(false)

    resolveRestart?.({ restarted: true })
    await Promise.all([firstDevices, secondDevices])
  })

  test('accepts an already loaded catalog model when an idle restart is unavailable', async () => {
    const catalogEntry = createDefaultLocalModelCatalogEntry({
      id: 'loaded-model',
      displayName: 'Loaded model',
      toolProfile: 'native',
    })
    saveLocalModelConfig({
      id: 'loaded-model',
      displayName: 'Loaded model',
      modelId: 'loaded-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogEntry,
      codexCatalogModelId: String(catalogEntry.slug),
      catalogReady: false,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return { restarted: false }
      if (method === 'runtime.codex.models.list') {
        return { data: [{ id: catalogEntry.slug }] }
      }
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
        version: '1.9.0',
        runtimeInstanceId: 'runtime-1',
      }),
      request,
      subscribe: vi.fn(),
    })

    await services.deviceApi.listDevices()

    expect(findLocalModelConfigByModelName(String(catalogEntry.slug))?.catalogReady).toBe(true)
    expect(request).toHaveBeenCalledWith('runtime.codex.models.list', { includeHidden: true })
  })

  test('retries an idle catalog restart after startup requests drain', async () => {
    const catalogEntry = createDefaultLocalModelCatalogEntry({
      id: 'startup-pending-model',
      displayName: 'Startup pending model',
      toolProfile: 'native',
    })
    saveLocalModelConfig({
      id: 'startup-pending-model',
      displayName: 'Startup pending model',
      modelId: 'startup-pending-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogEntry,
      codexCatalogModelId: String(catalogEntry.slug),
      catalogReady: false,
    })
    let restartCount = 0
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') {
        restartCount += 1
        return restartCount === 1
          ? { restarted: false, activeTaskCount: 0, pendingRequestCount: 1 }
          : { restarted: true, activeTaskCount: 0, pendingRequestCount: 0 }
      }
      if (method === 'runtime.codex.models.list') return { data: [] }
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
        version: '1.9.0',
        runtimeInstanceId: 'runtime-1',
      }),
      request,
      subscribe: vi.fn(),
    })

    const models = await services.modelApi.listModels()

    expect(restartCount).toBe(2)
    expect(models.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'local-model:startup-pending-model' }),
      ])
    )
  })

  test('hides official Codex models without auth while keeping provider models', async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'device.execute_command') {
        return {
          success: true,
          stdout: { exists: false },
          stderr: '',
          error: null,
        }
      }
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
              data: OFFICIAL_CODEX_MODELS,
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

    const models = await services.modelApi.listModels()

    expect(models).toEqual({
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
    expect(models.data.some(model => model.config?.weworkModelKind === 'codex-official')).toBe(
      false
    )
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
      user: { id: 9, user_name: 'hongyu9', email: 'hongyu9@example.com' },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      runtimeProjectKey: 'product',
      runtimeProjectName: 'Product',
      runtimeWorkspaceRoots: ['/Users/me/project', '/Users/me/api'],
      projectInstructions: 'Run focused project tests.',
      projectPlugins: [
        {
          id: 'quality-gate@team-market',
          pluginName: 'quality-gate',
          marketplaceId: 'team-market',
          displayName: 'Quality Gate',
        },
      ],
      cloudProjectId: 'cloud-project-42',
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
          local_path: '/Users/me/.wework/workspace/attachments/draft/-45/clipboard.png',
          local_preview_url: '/Users/me/.wework/workspace/attachments/draft/-45/clipboard.png',
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
      runtimeProjectKey: 'product',
      runtimeProjectName: 'Product',
      runtimeWorkspaceRoots: ['/Users/me/project', '/Users/me/api'],
      projectInstructions: 'Run focused project tests.',
      projectPlugins: [
        {
          id: 'quality-gate@team-market',
          pluginName: 'quality-gate',
          marketplaceId: 'team-market',
          displayName: 'Quality Gate',
        },
      ],
      cloudProjectId: 'cloud-project-42',
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
          local_path: '/Users/me/.wework/workspace/attachments/draft/-45/clipboard.png',
          local_preview_url: '/Users/me/.wework/workspace/attachments/draft/-45/clipboard.png',
        },
      ],
      executionRequest: expect.objectContaining({
        system_prompt: 'Run focused project tests.',
        project_plugin_ids: ['quality-gate@team-market'],
        task_id: 'task-1',
        subtask_id: expect.any(String),
        team_id: 0,
        team_name: 'local-wework',
        user_id: 9,
        user_name: 'hongyu9',
        user: {
          id: 9,
          name: 'hongyu9',
          user_name: 'hongyu9',
          email: 'hongyu9@example.com',
        },
        cloudProjectId: 'cloud-project-42',
        task_title: 'Hello',
        subtask_title: 'Hello - Assistant',
        prompt: 'hello',
        model_config: expect.objectContaining({
          model: 'openai',
          model_id: 'gpt-5',
          wework_model_kind: 'codex-official',
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
        runtime_project_key: 'product',
        runtime_project_name: 'Product',
        runtime_workspace_roots: ['/Users/me/project', '/Users/me/api'],
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
            status: 'ready',
            subtask_id: expect.any(String),
            file_extension: '.png',
            local_path: '/Users/me/.wework/workspace/attachments/draft/-45/clipboard.png',
            local_preview_url: '/Users/me/.wework/workspace/attachments/draft/-45/clipboard.png',
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

  test('keeps backend attachment metadata in direct runtime execution requests', async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'cloud-device',
      taskId: 'task-cloud-attachment',
      workspacePath: '/workspace/project',
      runtime: 'codex',
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'cloud-device' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'cloud-device',
      workspacePath: '/workspace/project',
      taskId: 'task-cloud-attachment',
      runtime: 'codex',
      message: 'inspect the image',
      attachments: [
        {
          id: 42,
          filename: 'cloud-image.png',
          file_size: 1200,
          mime_type: 'image/png',
          status: 'ready',
          file_extension: '.png',
          created_at: '2026-08-11T00:00:00.000Z',
        },
      ],
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.attachments).toEqual([
      {
        id: 42,
        filename: 'cloud-image.png',
        original_filename: 'cloud-image.png',
        file_size: 1200,
        mime_type: 'image/png',
        status: 'ready',
        subtask_id: expect.any(String),
        file_extension: '.png',
      },
    ])
  })

  test('runs Claude Code through the ordinary runtime task conversation API', async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.tasks.create') {
        return {
          accepted: true,
          deviceId: 'device-uuid',
          taskId: 'claude-task',
          workspacePath: '/Users/me/project',
          runtime: 'claude_code',
        }
      }
      return { accepted: true }
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
      taskId: 'claude-task',
      runtime: 'claude_code',
      runtimeExecutablePath: '/Users/me/.local/bin/claude',
      message: 'hello',
      title: 'Claude',
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'claude-task',
        runtime: 'claude_code',
      },
      message: 'continue',
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]

    expect(createPayload.runtime).toBe('claude_code')
    expect(createPayload.executionRequest.bot).toEqual([{ id: 0, shell_type: 'ClaudeCode' }])
    expect(createPayload.executionRequest.runtime_executable_path).toBe(
      '/Users/me/.local/bin/claude'
    )
    expect(createPayload.executionRequest.model_config).toEqual({})
    expect(createPayload).not.toHaveProperty('friendlyTitleExecutionRequest')
    expect(sendPayload.address.runtime).toBe('claude_code')
    expect(sendPayload.executionRequest.bot).toEqual([{ id: 0, shell_type: 'ClaudeCode' }])
    expect(sendPayload.executionRequest.model_config).toEqual({})
  })

  test('keeps a prepared model_config and applies the selected runtime options', async () => {
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
      return {}
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      user: { id: 9, user_name: 'hongyu9', email: 'hongyu9@example.com' },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      cloudProjectId: 'cloud-project-42',
      taskId: 'task-1',
      runtime: 'codex',
      message: 'run the scan',
      title: 'Scan',
      modelId: 'wecode-kimi',
      modelConfig: {
        base_url: 'https://gateway.example/api/runtime-work/llm-responses-proxy',
        api_key: 'short-lived-token',
        codex_catalog_model_id: 'wework-kimi-k2-7',
        codex_responses_compat_proxy: true,
        reasoning: { effort: 'high' },
      },
      modelOptions: {
        reasoning: 'low',
        speed: 'fast',
      },
    })

    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.create',
      expect.objectContaining({
        executionRequest: expect.objectContaining({
          model_config: expect.objectContaining({
            base_url: 'https://gateway.example/api/runtime-work/llm-responses-proxy',
            api_key: 'short-lived-token',
            codex_catalog_model_id: 'wework-kimi-k2-7',
            reasoning: { effort: 'low' },
            service_tier: 'fast',
          }),
        }),
      })
    )
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

  test('persists projectless automations as standalone chat workspaces', async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method === 'runtime.automations.create') {
          return { automation: data.automation }
        }
        return {}
      })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.automationApi?.createAutomation({
      source: 'local',
      name: 'Projectless automation',
      prompt: 'Say hello',
      schedule: { type: 'interval', value: 1, unit: 'hours' },
      timezone: 'Asia/Shanghai',
      enabled: true,
      conversationMode: 'independent',
      notificationPolicy: 'all_runs',
      taskRequest: {
        deviceId: 'local-device',
        standaloneChatWorkspace: true,
        teamId: 0,
        runtime: 'codex',
        message: 'Say hello',
        initialGoal: {
          objective: 'Say hello',
          status: 'active',
          tokenBudget: null,
        },
      },
    })

    expect(request).toHaveBeenCalledWith(
      'runtime.automations.create',
      {
        automation: expect.objectContaining({
          taskPayload: expect.objectContaining({
            standaloneChatWorkspace: true,
            initialGoal: {
              objective: 'Say hello',
              status: 'active',
              tokenBudget: null,
            },
            executionRequest: expect.objectContaining({
              standalone_chat_workspace: true,
            }),
          }),
        }),
      },
      'local-device'
    )
    const automationPayload = request.mock.calls[0]?.[1]?.automation.taskPayload
    expect(automationPayload).not.toHaveProperty('workspacePath')
    expect(automationPayload.executionRequest).not.toHaveProperty('project_workspace_path')
  })

  test('defers git worktree creation to the local runtime scheduler', async () => {
    const worktreePath = '/Users/me/.wework/workspace/worktrees/task-1/project'
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method === 'device.execute_command') {
          if (data.command_key === 'git_is_worktree') {
            return { success: true, stdout: 'true', stderr: '', exit_code: 0 }
          }
        }
        if (method === 'runtime.tasks.create') {
          return {
            accepted: true,
            taskId: 'task-1',
            workspacePath: worktreePath,
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
    expect(request).not.toHaveBeenCalledWith('runtime.worktrees.prepare', expect.anything())
    expect(createPayload).toEqual(
      expect.objectContaining({
        deviceId: 'device-uuid',
        workspacePath: '/Users/me/project',
        execution: {
          workspace: {
            source: 'git_worktree',
            path: '/Users/me/project',
          },
        },
        executionRequest: expect.objectContaining({
          workspace_source: 'git_worktree',
          project_workspace_path: '/Users/me/project',
          workspace: {
            project: {
              source: 'git_worktree',
              path: '/Users/me/project',
            },
          },
        }),
      })
    )
  })

  test('passes an explicit worktree branch when creating a local runtime task', async () => {
    const worktreePath = '/Users/me/.wework/workspace/worktrees/task-1/project'
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method === 'device.execute_command') {
          if (data.command_key === 'git_is_worktree') {
            return { success: true, stdout: 'true', stderr: '', exit_code: 0 }
          }
        }
        if (method === 'runtime.tasks.create') {
          return {
            accepted: true,
            taskId: 'task-1',
            workspacePath: worktreePath,
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
    expect(request).not.toHaveBeenCalledWith('runtime.worktrees.prepare', expect.anything())
    expect(createPayload).toEqual(
      expect.objectContaining({
        workspacePath: '/Users/me/project',
        execution: {
          workspace: {
            source: 'git_worktree',
            path: '/Users/me/project',
            branch: 'develop',
          },
        },
        executionRequest: expect.objectContaining({
          workspace: {
            project: {
              source: 'git_worktree',
              path: '/Users/me/project',
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
      clientUserMessageId: 'runtime-local-pane-1',
      cloudProjectId: 'cloud-project-42',
      origin: {
        type: 'board_task',
        cloudProjectId: 'cloud-project-42',
        loopItemId: 'ISSUE-42',
      },
      modelId: 'gpt-5.4',
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
          local_path: '/Users/me/.wework/workspace/attachments/draft/-46/follow-up.png',
          local_preview_url: '/Users/me/.wework/workspace/attachments/draft/-46/follow-up.png',
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
        clientUserMessageId: 'runtime-local-pane-1',
        cloudProjectId: 'cloud-project-42',
        origin: {
          type: 'board_task',
          cloudProjectId: 'cloud-project-42',
          loopItemId: 'ISSUE-42',
        },
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
            local_path: '/Users/me/.wework/workspace/attachments/draft/-46/follow-up.png',
            local_preview_url: '/Users/me/.wework/workspace/attachments/draft/-46/follow-up.png',
          },
        ],
        executionRequest: expect.objectContaining({
          task_id: 'task-1',
          subtask_id: expect.any(String),
          prompt: 'continue',
          client_user_message_id: 'runtime-local-pane-1',
          model_config: expect.objectContaining({
            model: 'openai',
            model_id: 'gpt-5.4',
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
          cloudProjectId: 'cloud-project-42',
          origin: {
            type: 'board_task',
            cloudProjectId: 'cloud-project-42',
            loopItemId: 'ISSUE-42',
          },
          collaborationMode: 'default',
          attachments: [
            {
              id: -46,
              filename: 'follow-up.png',
              original_filename: 'follow-up.png',
              file_size: 640,
              mime_type: 'image/png',
              status: 'ready',
              subtask_id: expect.any(String),
              file_extension: '.png',
              local_path: '/Users/me/.wework/workspace/attachments/draft/-46/follow-up.png',
              local_preview_url: '/Users/me/.wework/workspace/attachments/draft/-46/follow-up.png',
            },
          ],
        }),
      })
    )
    expect(sendPayload).not.toHaveProperty('message_id')
    expect(sendPayload).not.toHaveProperty('modelId')
  })

  test('builds the shared execution request for local interrupt-and-send', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-login-token',
      },
    })

    await services.runtimeWorkApi?.interruptAndSendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'stop and use this direction',
      clientUserMessageId: 'runtime-interrupt-1',
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
      },
    })

    const payload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.interrupt_and_send'
    )?.[1]
    expect(payload).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        address: {
          deviceId: 'device-uuid',
          workspacePath: '/Users/me/project',
          taskId: 'task-1',
        },
        message: 'stop and use this direction',
        clientUserMessageId: 'runtime-interrupt-1',
        executionRequest: expect.objectContaining({
          prompt: 'stop and use this direction',
          client_user_message_id: 'runtime-interrupt-1',
          new_session: false,
          model_config: expect.objectContaining({
            model_id: 'shared-model',
            codex_catalog_model_id: 'wework-gpt-5.6-sol',
            base_url: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
            api_key: 'cloud-login-token',
            default_headers: {
              'X-Wegent-Model-Type': 'user',
              'X-Wegent-Model-Namespace': 'default',
              'X-Wegent-Model-User-Id': '42',
              'X-Wegent-Upstream-Header-wecode-executor': 'codex',
              'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
            },
          }),
        }),
      })
    )
    expect(payload).not.toHaveProperty('modelId')
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
      clientUserMessageId: 'user-edited',
      retrySourceTurnId: 'turn-last',
      modelId: 'gpt-5.4',
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
        clientUserMessageId: 'user-edited',
        retrySourceTurnId: 'turn-last',
        collaborationMode: 'default',
        modelOptions: {
          collaborationMode: 'default',
          reasoning: 'high',
        },
        executionRequest: expect.objectContaining({
          task_id: 'task-1',
          subtask_id: expect.any(String),
          prompt: 'edited question',
          client_user_message_id: 'user-edited',
          new_session: false,
          model_config: expect.objectContaining({
            model: 'openai',
            model_id: 'gpt-5.4',
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
    const ollama = saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      modelId: 'gpt-oss:20b',
      baseUrl: 'http://localhost:11434/v1',
      contextWindow: 128000,
      catalogReady: true,
    })
    const lmstudio = saveLocalModelConfig({
      id: 'lmstudio',
      displayName: 'LM Studio',
      modelId: 'qwen3-coder',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'real-key',
      webSearchMode: 'cached',
      imageGenerationEnabled: true,
      catalogReady: true,
    })
    const custom = saveLocalModelConfig({
      id: 'custom',
      displayName: 'Custom Gateway',
      modelId: 'custom-model',
      baseUrl: 'http://localhost:9876/api',
      requestPath: '/respond',
      catalogReady: true,
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
      modelId: ollama.codexCatalogModelId,
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'continue',
      modelId: ollama.codexCatalogModelId,
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'secure continue',
      modelId: lmstudio.codexCatalogModelId,
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-1',
      },
      message: 'custom continue',
      modelId: custom.codexCatalogModelId,
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
    expect(sendPayloads.map(payload => payload.modelSelection)).toEqual([
      { modelName: ollama.codexCatalogModelId, modelType: null, options: {} },
      { modelName: lmstudio.codexCatalogModelId, modelType: null, options: {} },
      { modelName: custom.codexCatalogModelId, modelType: null, options: {} },
    ])
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

  test('sends configured model settings to a cloud device executor', async () => {
    saveLocalModelConfig({
      id: 'cloud-ollama',
      displayName: 'Cloud Ollama',
      modelId: 'qwen3-coder',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'cloud-device-key',
      catalogReady: false,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return { restarted: true }
      if (method === 'runtime.codex.models.list') {
        return { data: [{ id: 'wework-custom-cloud-ollama' }] }
      }
      return { accepted: true }
    })
    const requestModelCatalogSync = vi.fn(async ({ sync }: { sync: () => Promise<void> }) => {
      await sync()
      return true
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync,
      resolveDeviceName: () => 'Cloud Executor',
    })

    await runtimeApi.createRuntimeTask({
      teamId: 0,
      deviceId: 'cloud-device',
      workspacePath: '/workspace/project',
      taskId: 'cloud-task',
      runtime: 'codex',
      message: 'hello from cloud',
      modelId: 'local-model:cloud-ollama',
    })
    await runtimeApi.sendRuntimeMessage({
      address: {
        deviceId: 'cloud-device',
        workspacePath: '/workspace/project',
        taskId: 'cloud-task',
      },
      message: 'continue from cloud',
      modelId: 'local-model:cloud-ollama',
    })
    await runtimeApi.setRuntimeSupervisor({
      address: {
        deviceId: 'cloud-device',
        workspacePath: '/workspace/project',
        taskId: 'cloud-task',
      },
      mode: 'auto',
      modelSelection: {
        modelName: 'local-model:cloud-ollama',
        modelType: 'runtime',
        options: {},
      },
      intervalSeconds: 30,
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
    const supervisorPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.supervisor.set'
    )?.[1]
    const expectedModelConfig = expect.objectContaining({
      model_id: 'qwen3-coder',
      base_url: 'http://localhost:11434/v1',
      responses_url: 'http://localhost:11434/v1/responses',
      api_key: 'cloud-device-key',
      codex_responses_compat_proxy: true,
    })

    expect(createPayload.executionRequest.model_config).toEqual(expectedModelConfig)
    expect(sendPayload.executionRequest.model_config).toEqual(expectedModelConfig)
    expect(supervisorPayload.modelConfig).toEqual(expectedModelConfig)
    expect(requestModelCatalogSync).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'cloud-device',
        deviceName: 'Cloud Executor',
        modelName: 'Cloud Ollama',
      })
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.codex.catalog.custom.write',
      {
        models: [
          expect.objectContaining({
            slug: 'wework-custom-cloud-ollama',
          }),
        ],
      },
      'cloud-device'
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.codex.app_server.restart',
      { ifIdle: true },
      'cloud-device'
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.codex.models.list',
      { includeHidden: true },
      'cloud-device'
    )
    expect(request).toHaveBeenCalledWith('runtime.tasks.create', expect.any(Object), 'cloud-device')
    expect(request).toHaveBeenCalledWith('runtime.tasks.send', expect.any(Object), 'cloud-device')
    expect(requestModelCatalogSync).toHaveBeenCalledTimes(1)
    expect(listLocalModelConfigs()[0]).toMatchObject({
      id: 'cloud-ollama',
      catalogReady: false,
    })
  })

  test('builds cloud automation payloads from a remotely synchronized model catalog', async () => {
    saveLocalModelConfig({
      id: 'cloud-automation-task',
      displayName: 'Cloud Automation Task',
      modelId: 'qwen3-coder-task',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'cloud-device-key',
      catalogReady: false,
    })
    saveLocalModelConfig({
      id: 'cloud-automation-continuation',
      displayName: 'Cloud Automation Continuation',
      modelId: 'qwen3-coder-continuation',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'cloud-device-key',
      catalogReady: false,
    })
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method === 'runtime.codex.app_server.restart') return { restarted: true }
        if (method === 'runtime.codex.models.list') {
          return {
            data: [
              { id: 'wework-custom-cloud-automation-task' },
              { id: 'wework-custom-cloud-automation-continuation' },
            ],
          }
        }
        if (method === 'runtime.automations.create') return { automation: data.automation }
        return { saved: true }
      })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync: async ({ sync }) => {
        await sync()
        return true
      },
    })
    const prepareRuntimeModel = vi.fn(data => runtimeApi.prepareRuntimeModel(data))
    const automationApi = createAutomationApiFromIpc(
      request,
      (method, data) => request(method, data as Record<string, unknown>),
      {
        resolveDeviceId: async () => 'cloud-device',
        syncConfiguredModelCatalog: true,
        prepareRuntimeModel,
      },
      'cloud-device',
      'cloud'
    )

    await automationApi.createAutomation({
      source: 'cloud',
      name: 'Cloud automation',
      prompt: 'Run remotely',
      schedule: { type: 'interval', value: 1, unit: 'hours' },
      timezone: 'UTC',
      enabled: true,
      conversationMode: 'continue_thread',
      notificationPolicy: 'all_runs',
      taskRequest: {
        deviceId: 'cloud-device',
        workspacePath: '/workspace/project',
        teamId: 0,
        runtime: 'codex',
        message: 'Run remotely',
        modelId: 'local-model:cloud-automation-task',
      },
      continuationPayload: {
        address: {
          deviceId: 'cloud-device',
          workspacePath: '/workspace/project',
          taskId: 'cloud-task',
        },
        message: 'Continue remotely',
        modelId: 'local-model:cloud-automation-continuation',
      },
    })

    const automation = request.mock.calls.find(
      ([method]) => method === 'runtime.automations.create'
    )?.[1].automation
    expect(automation.taskPayload.executionRequest.model_config).toMatchObject({
      model_id: 'qwen3-coder-task',
      api_key: 'cloud-device-key',
    })
    expect(automation.continuationPayload.executionRequest.model_config).toMatchObject({
      model_id: 'qwen3-coder-continuation',
      api_key: 'cloud-device-key',
    })
    expect(prepareRuntimeModel).toHaveBeenCalledWith({
      deviceId: 'cloud-device',
      modelId: 'local-model:cloud-automation-task',
    })
    expect(prepareRuntimeModel).toHaveBeenCalledWith({
      deviceId: 'cloud-device',
      modelId: 'local-model:cloud-automation-continuation',
    })
    const methods = request.mock.calls.map(([method]) => method)
    expect(methods.indexOf('runtime.codex.catalog.custom.write')).toBeLessThan(
      methods.indexOf('runtime.automations.create')
    )
    expect(methods.indexOf('runtime.codex.app_server.restart')).toBeLessThan(
      methods.indexOf('runtime.automations.create')
    )
    expect(methods.indexOf('runtime.codex.models.list')).toBeLessThan(
      methods.indexOf('runtime.automations.create')
    )
  })

  test('does not create a cloud automation when model catalog synchronization is cancelled', async () => {
    saveLocalModelConfig({
      id: 'cloud-automation-cancelled',
      displayName: 'Cloud Automation Cancelled',
      modelId: 'cancelled-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: false,
    })
    const request = vi.fn()
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync: vi.fn().mockResolvedValue(false),
    })
    const automationApi = createAutomationApiFromIpc(
      request,
      (method, data) => request(method, data as Record<string, unknown>),
      {
        resolveDeviceId: async () => 'cloud-device',
        syncConfiguredModelCatalog: true,
        prepareRuntimeModel: data => runtimeApi.prepareRuntimeModel(data),
      },
      'cloud-device',
      'cloud'
    )

    await expect(
      automationApi.createAutomation({
        source: 'cloud',
        name: 'Cancelled automation',
        prompt: 'Do not save',
        schedule: { type: 'interval', value: 1, unit: 'hours' },
        timezone: 'UTC',
        enabled: true,
        conversationMode: 'independent',
        notificationPolicy: 'all_runs',
        taskRequest: {
          deviceId: 'cloud-device',
          workspacePath: '/workspace/project',
          teamId: 0,
          runtime: 'codex',
          message: 'Do not save',
          modelId: 'local-model:cloud-automation-cancelled',
        },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith(
      'runtime.automations.create',
      expect.anything(),
      'cloud-device'
    )
  })

  test('does not create a cloud automation when synchronized model verification fails', async () => {
    saveLocalModelConfig({
      id: 'cloud-automation-missing',
      displayName: 'Cloud Automation Missing',
      modelId: 'missing-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: false,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return { restarted: true }
      if (method === 'runtime.codex.models.list') return { data: [] }
      return { saved: true }
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync: async ({ sync }) => {
        await sync()
        return true
      },
    })
    const automationApi = createAutomationApiFromIpc(
      request,
      (method, data) => request(method, data as Record<string, unknown>),
      {
        resolveDeviceId: async () => 'cloud-device',
        syncConfiguredModelCatalog: true,
        prepareRuntimeModel: data => runtimeApi.prepareRuntimeModel(data),
      },
      'cloud-device',
      'cloud'
    )

    await expect(
      automationApi.createAutomation({
        source: 'cloud',
        name: 'Missing automation',
        prompt: 'Do not save',
        schedule: { type: 'interval', value: 1, unit: 'hours' },
        timezone: 'UTC',
        enabled: true,
        conversationMode: 'independent',
        notificationPolicy: 'all_runs',
        taskRequest: {
          deviceId: 'cloud-device',
          workspacePath: '/workspace/project',
          teamId: 0,
          runtime: 'codex',
          message: 'Do not save',
          modelId: 'local-model:cloud-automation-missing',
        },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith(
      'runtime.automations.create',
      expect.anything(),
      'cloud-device'
    )
  })

  test('synchronizes the same configured catalog independently for each cloud device', async () => {
    saveLocalModelConfig({
      id: 'cloud-multi-device',
      displayName: 'Cloud multi-device',
      modelId: 'multi-device-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return { restarted: true }
      if (method === 'runtime.codex.models.list') {
        return { data: [{ id: 'wework-custom-cloud-multi-device' }] }
      }
      return { saved: true }
    })
    const requestModelCatalogSync = vi.fn(async ({ sync }: { sync: () => Promise<void> }) => {
      await sync()
      return true
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'device-a', {
      resolveDeviceId: async data => String(data.deviceId),
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync,
    })

    await runtimeApi.prepareRuntimeModel({
      deviceId: 'device-a',
      modelId: 'local-model:cloud-multi-device',
    })
    await runtimeApi.prepareRuntimeModel({
      deviceId: 'device-b',
      modelId: 'local-model:cloud-multi-device',
    })

    expect(requestModelCatalogSync).toHaveBeenCalledTimes(2)
    expect(
      request.mock.calls.filter(([method]) => method === 'runtime.codex.catalog.custom.write')
    ).toEqual([
      expect.arrayContaining([
        'runtime.codex.catalog.custom.write',
        expect.any(Object),
        'device-a',
      ]),
      expect.arrayContaining([
        'runtime.codex.catalog.custom.write',
        expect.any(Object),
        'device-b',
      ]),
    ])
    expect(request.mock.calls.filter(([method]) => method === 'runtime.codex.models.list')).toEqual(
      [
        ['runtime.codex.models.list', { includeHidden: true }, 'device-a'],
        ['runtime.codex.models.list', { includeHidden: true }, 'device-b'],
      ]
    )
  })

  test('does not send when cloud model catalog synchronization is cancelled', async () => {
    saveLocalModelConfig({
      id: 'cloud-cancelled',
      displayName: 'Cloud Cancelled',
      modelId: 'cancelled-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const request = vi.fn()
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync: vi.fn().mockResolvedValue(false),
    })

    await expect(
      runtimeApi.prepareRuntimeModel({
        deviceId: 'cloud-device',
        modelId: 'local-model:cloud-cancelled',
      })
    ).resolves.toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  test('does not reuse an in-flight catalog confirmation after the catalog changes', async () => {
    saveLocalModelConfig({
      id: 'cloud-changing',
      displayName: 'Cloud Changing',
      modelId: 'changing-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const confirmations: Array<(confirmed: boolean) => void> = []
    const requestModelCatalogSync = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          confirmations.push(resolve)
        })
    )
    const runtimeApi = createRuntimeWorkApiFromIpc(vi.fn(), async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync,
    })

    const firstPrepare = runtimeApi.prepareRuntimeModel({
      deviceId: 'cloud-device',
      modelId: 'local-model:cloud-changing',
    })
    await vi.waitFor(() => expect(requestModelCatalogSync).toHaveBeenCalledTimes(1))

    saveLocalModelConfig({
      id: 'cloud-changing',
      displayName: 'Cloud Changing v2',
      modelId: 'changing-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const secondPrepare = runtimeApi.prepareRuntimeModel({
      deviceId: 'cloud-device',
      modelId: 'local-model:cloud-changing',
    })
    await vi.waitFor(() => expect(requestModelCatalogSync).toHaveBeenCalledTimes(2))

    confirmations[0](false)
    confirmations[1](false)
    await expect(firstPrepare).resolves.toBe(false)
    await expect(secondPrepare).resolves.toBe(false)
  })

  test('serializes catalog writes per device and applies only the latest configuration', async () => {
    const firstConfig = saveLocalModelConfig({
      id: 'cloud-serialized',
      displayName: 'Cloud Serialized v1',
      modelId: 'serialized-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const syncRequests: Array<{
      sync: () => Promise<void>
      resolve: (confirmed: boolean) => void
    }> = []
    const requestModelCatalogSync = vi.fn(
      ({ sync }: { sync: () => Promise<void> }) =>
        new Promise<boolean>(resolve => {
          syncRequests.push({ sync, resolve })
        })
    )
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return { restarted: true }
      if (method === 'runtime.codex.models.list') {
        return { data: [{ id: 'wework-custom-cloud-serialized' }] }
      }
      return { saved: true }
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync,
    })

    const firstPrepare = runtimeApi.prepareRuntimeModel({
      deviceId: 'cloud-device',
      modelId: 'local-model:cloud-serialized',
    })
    await vi.waitFor(() => expect(syncRequests).toHaveLength(1))
    saveLocalModelConfig({
      id: 'cloud-serialized',
      displayName: 'Cloud Serialized v2',
      modelId: 'serialized-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogEntry: {
        ...firstConfig.catalogEntry,
        display_name: 'Cloud Serialized v2',
      },
      catalogReady: true,
    })
    const secondPrepare = runtimeApi.prepareRuntimeModel({
      deviceId: 'cloud-device',
      modelId: 'local-model:cloud-serialized',
    })
    await vi.waitFor(() => expect(syncRequests).toHaveLength(2))

    await syncRequests[1].sync()
    syncRequests[1].resolve(true)
    await expect(secondPrepare).resolves.toBe(true)
    await syncRequests[0].sync()
    syncRequests[0].resolve(true)
    await expect(firstPrepare).resolves.toBe(true)

    await expect(
      runtimeApi.prepareRuntimeModel({
        deviceId: 'cloud-device',
        modelId: 'local-model:cloud-serialized',
      })
    ).resolves.toBe(true)
    expect(requestModelCatalogSync).toHaveBeenCalledTimes(2)
    const catalogWrites = request.mock.calls.filter(
      ([method]) => method === 'runtime.codex.catalog.custom.write'
    )
    expect(catalogWrites).toHaveLength(1)
    expect(catalogWrites[0][1]).toEqual({
      models: [
        expect.objectContaining({
          slug: 'wework-custom-cloud-serialized',
          display_name: 'Cloud Serialized v2',
        }),
      ],
    })
  })

  test('reports a busy cloud Codex without forcing a restart', async () => {
    saveLocalModelConfig({
      id: 'cloud-busy',
      displayName: 'Cloud Busy',
      modelId: 'busy-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') {
        return { restarted: false, requiresConfirmation: true }
      }
      return { saved: true }
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync: async ({ sync }) => {
        await sync()
        return true
      },
    })

    await expect(
      runtimeApi.prepareRuntimeModel({
        deviceId: 'cloud-device',
        modelId: 'local-model:cloud-busy',
      })
    ).rejects.toThrow('正在运行')
    expect(request).toHaveBeenCalledWith(
      'runtime.codex.app_server.restart',
      { ifIdle: true },
      'cloud-device'
    )
  })

  test('rejects the send when the restarted cloud Codex does not list the selected model', async () => {
    saveLocalModelConfig({
      id: 'cloud-missing',
      displayName: 'Cloud Missing',
      modelId: 'missing-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: true,
    })
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return { restarted: true }
      if (method === 'runtime.codex.models.list') return { data: [{ id: 'another-model' }] }
      return { saved: true }
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'cloud-device', {
      resolveDeviceId: async () => 'cloud-device',
      transportLabel: 'Cloud',
      syncConfiguredModelCatalog: true,
      requestModelCatalogSync: async ({ sync }) => {
        await sync()
        return true
      },
    })

    await expect(
      runtimeApi.sendRuntimeMessage({
        address: {
          deviceId: 'cloud-device',
          workspacePath: '/workspace/project',
          taskId: 'cloud-task',
        },
        message: 'must not send',
        modelId: 'local-model:cloud-missing',
      })
    ).rejects.toThrow('重启后未加载目标模型')
    expect(request).not.toHaveBeenCalledWith(
      'runtime.tasks.send',
      expect.anything(),
      'cloud-device'
    )
  })

  test('uses the built-in K3 catalog profile with 256K context and low reasoning', async () => {
    saveLocalModelConfig({
      id: 'kimi-k3',
      providerProfileId: 'kimi-coding',
      displayName: 'Kimi K3',
      modelId: 'k3',
      baseUrl: 'https://api.kimi.com/coding/v1',
      contextWindow: 262_144,
      codexCatalogModelId: 'wework-kimi-k3',
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
      taskId: 'task-k3',
      runtime: 'codex',
      message: 'hello',
      title: 'K3',
      modelId: 'local-model:kimi-k3',
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        model_id: 'k3',
        codex_catalog_model_id: 'wework-kimi-k3',
        model_context_window: 262_144,
        reasoning: { effort: 'low' },
      })
    )
  })

  test.each([
    ['deepseek-v4-flash', 'wework-deepseek-v4-flash'],
    ['deepseek-v4-pro', 'wework-deepseek-v4-pro'],
  ])(
    'uses the native %s Responses profile with high reasoning',
    async (modelId, catalogModelId) => {
      saveLocalModelConfig({
        id: modelId,
        providerProfileId: 'deepseek',
        displayName: modelId,
        modelId,
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai-responses',
        toolProfile: 'custom',
        requestPath: '/responses',
        apiKey: 'deepseek-key',
        contextWindow: 1_048_576,
        codexCatalogModelId: catalogModelId,
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
        taskId: `task-${modelId}`,
        runtime: 'codex',
        message: 'hello',
        title: 'DeepSeek',
        modelId: `local-model:${modelId}`,
      })

      const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
      expect(payload.executionRequest.model_config).toEqual(
        expect.objectContaining({
          model_id: modelId,
          base_url: 'https://api.deepseek.com',
          responses_url: 'https://api.deepseek.com/responses',
          upstream_api_format: 'openai-responses',
          tool_profile: 'custom',
          codex_catalog_model_id: catalogModelId,
          model_context_window: 1_048_576,
          reasoning: { effort: 'high' },
        })
      )
      expect(payload.executionRequest.model_config).not.toHaveProperty('native_tool_search')
      expect(payload.executionRequest.model_config).not.toHaveProperty('native_namespace_tools')
      expect(payload.executionRequest.model_config).not.toHaveProperty('vision_sidecar')
    }
  )

  test('routes DeepSeek images through a configured vision proxy model', async () => {
    const visionCatalog = createDefaultLocalModelCatalogEntry({
      id: 'vision',
      displayName: 'Vision',
      toolProfile: 'custom',
    })
    visionCatalog.input_modalities = ['text', 'image']
    saveLocalModelConfig({
      id: 'vision',
      providerProfileId: 'custom',
      displayName: 'Vision',
      modelId: 'vision-model',
      baseUrl: 'https://vision.example/v1',
      apiFormat: 'openai-responses',
      requestPath: '/responses',
      apiKey: 'vision-key',
      catalogEntry: visionCatalog,
    })
    saveLocalModelConfig({
      id: 'deepseek-vision',
      providerProfileId: 'deepseek',
      displayName: 'DeepSeek V4 Flash',
      modelId: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai-responses',
      requestPath: '/responses',
      apiKey: 'deepseek-key',
      codexCatalogModelId: 'wework-deepseek-v4-flash',
      visionModelConfigId: 'vision',
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
      taskId: 'task-deepseek-vision',
      runtime: 'codex',
      message: 'inspect the screenshot',
      title: 'DeepSeek Vision',
      modelId: 'local-model:deepseek-vision',
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        codex_catalog_model_id: 'wework-deepseek-v4-flash',
        vision_sidecar: {
          enabled: true,
          request_url: 'https://vision.example/v1/responses',
          api_format: 'openai-responses',
          api_key: 'vision-key',
          model_id: 'vision-model',
          max_descriptions_per_turn: 8,
          timeout_ms: 45_000,
        },
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
        codexProviderType: 'provider',
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
        codexProviderType: 'provider',
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
        wework_model_kind: 'codex-provider',
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

  test('keeps official Codex classification when OpenAI provider metadata is present', async () => {
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
        codexProviderId: 'openai',
        codexProviderName: 'OpenAI',
        codexProviderType: 'official',
        permissionMode: 'full-access',
      },
    })

    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]

    expect(sendPayload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        model: 'openai',
        model_id: 'gpt-5.5',
        wework_model_kind: 'codex-official',
        model_provider: 'openai',
        provider_name: 'OpenAI',
      })
    )
    expect(sendPayload.executionRequest.runtime_permission_profile).toBe(':danger-full-access')
  })

  test('builds cloud model gateway config without resolving credentials', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example.com/custom/api/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-login-token',
        backendUrl: 'https://cloud.example.com/custom',
      },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelContextWindow: '1048576',
        weworkCloudModelMaxOutputTokens: '96000',
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        model: 'openai',
        model_id: 'shared-model',
        api_format: 'responses',
        tool_profile: 'custom',
        protocol: 'openai-responses',
        base_url: 'https://cloud.example.com/custom/api/runtime-work/llm-responses-proxy',
        api_key: 'cloud-login-token',
        model_context_window: 1048576,
        max_output_tokens: 96000,
        codex_responses_compat_proxy: true,
        default_headers: {
          'X-Wegent-Model-Type': 'user',
          'X-Wegent-Model-Namespace': 'default',
          'X-Wegent-Model-User-Id': '42',
          'X-Wegent-Upstream-Header-wecode-executor': 'codex',
          'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
        },
        runtime_config: {
          codex: {
            use_user_config: false,
            configured: true,
          },
        },
      })
    )
    expect(payload.executionRequest.mcp_servers).toEqual([])
    expect(payload.executionRequest).toEqual(
      expect.objectContaining({
        backend_url: 'https://cloud.example.com/custom',
        auth_token: 'cloud-login-token',
      })
    )
    expect(request).not.toHaveBeenCalledWith('runtime.models.resolve', expect.anything())
  })

  test('routes cloud model images through the configured cloud vision sidecar', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-login-token',
      },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-1',
      runtime: 'codex',
      message: 'describe the image',
      title: 'Vision',
      modelId: 'primary-cloud-model',
      modelType: 'user',
      modelOptions: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-pro',
        weworkCloudVisionSidecar:
          '{"modelName":"cloud-vision","modelType":"user","namespace":"default","resourceUserId":77,"apiFormat":"openai-responses"}',
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        codex_catalog_model_id: 'wework-deepseek-v4-pro',
        vision_sidecar: {
          enabled: true,
          request_url: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy/responses',
          api_format: 'openai-responses',
          api_key: 'cloud-login-token',
          model_id: 'cloud-vision',
          default_headers: {
            'X-Wegent-Model-Type': 'user',
            'X-Wegent-Model-Namespace': 'default',
            'X-Wegent-Model-User-Id': '77',
            'X-Wegent-Upstream-Header-wecode-executor': 'codex',
            'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
          },
          max_descriptions_per_turn: 8,
          timeout_ms: 45000,
        },
      })
    )
  })

  test('does not configure cloud vision delegation without an explicit reference', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-login-token',
      },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-text-only-deepseek',
      runtime: 'codex',
      message: 'text only',
      title: 'DeepSeek text only',
      modelId: 'deepseek-v4-pro-responses',
      modelType: 'public',
      modelOptions: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
        weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-pro',
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        codex_catalog_model_id: 'wework-deepseek-v4-pro',
      })
    )
    expect(payload.executionRequest.model_config).not.toHaveProperty('vision_sidecar')
  })

  test('builds cloud model gateway config with upstream_api_format for chat-completions protocol', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-login-token',
      },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-chat-completions',
        weworkCloudModelCodexCatalogModelId: 'wework-kimi-k3',
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        model: 'openai',
        model_id: 'shared-model',
        codex_catalog_model_id: 'wework-kimi-k3',
        api_format: 'responses',
        upstream_api_format: 'openai-chat-completions',
        native_tool_search: false,
        native_namespace_tools: false,
        tool_profile: 'custom',
        protocol: 'openai-responses',
        base_url: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
        api_key: 'cloud-login-token',
        default_headers: {
          'X-Wegent-Model-Type': 'user',
          'X-Wegent-Model-Namespace': 'default',
          'X-Wegent-Model-User-Id': '42',
          'X-Wegent-Upstream-Header-wecode-executor': 'codex',
          'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
        },
        runtime_config: {
          codex: {
            use_user_config: false,
            configured: true,
          },
        },
      })
    )
  })

  test('passes native Responses tool capabilities to the executor', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
        apiKey: 'cloud-login-token',
      },
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-native-responses',
      runtime: 'codex',
      message: 'build a site',
      title: 'Native Responses',
      modelId: 'gpt-5.6-sol',
      modelType: 'user',
      modelOptions: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
        weworkCloudModelNativeToolSearch: 'true',
        weworkCloudModelNativeNamespaceTools: 'true',
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.model_config).toEqual(
      expect.objectContaining({
        model_id: 'gpt-5.6-sol',
        upstream_api_format: 'openai-responses',
        native_tool_search: true,
        native_namespace_tools: true,
      })
    )
  })

  test('injects trusted cloud collaboration context without changing the visible message', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })
    const additionalContext = {
      cloudCollaboration: {
        kind: 'application' as const,
        value: 'Current TODO: WEG-1. Use the wework_space MCP tools when needed.',
      },
    }

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-cloud-context',
      runtime: 'codex',
      message: '这个 TODO 里有啥？',
      additionalContext,
    })
    await services.runtimeWorkApi?.sendRuntimeMessage({
      address: {
        deviceId: 'local-device',
        workspacePath: '/Users/me/project',
        taskId: 'task-cloud-context',
      },
      message: '这个云项目是解决什么问题？',
      additionalContext,
    })

    const createPayload = request.mock.calls.find(
      ([method]) => method === 'runtime.tasks.create'
    )?.[1]
    const sendPayload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
    expect(createPayload.message).toBe('这个 TODO 里有啥？')
    expect(createPayload.executionRequest.prompt).toContain('<application_context>')
    expect(createPayload.executionRequest.prompt).toContain('Current TODO: WEG-1')
    expect(createPayload.executionRequest.prompt).toContain('这个 TODO 里有啥？')
    expect(sendPayload.message).toBe('这个云项目是解决什么问题？')
    expect(sendPayload.executionRequest.prompt).toContain('Current TODO: WEG-1')
  })

  test('automatically deploys and emphasizes dws for a DingTalk AI Table project', async () => {
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
      taskId: 'task-dingtalk',
      runtime: 'codex',
      message: '把任务状态改成进行中',
      additionalContext: {
        dingtalkAITableProject: {
          kind: 'application',
          value: 'Base ID: base-1\nTable ID: table-1',
        },
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    expect(payload.executionRequest.skill_names).toEqual(['dws'])
    expect(payload.executionRequest.preload_skills).toEqual(['dws'])
    expect(payload.executionRequest.user_selected_skills).toEqual(['dws'])
  })

  test('activates project-space capabilities for a generic cloud reference', async () => {
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
      taskId: 'task-project-space',
      runtime: 'codex',
      message: '[$项目空间](cloud://projects) 帮我创建一个新项目',
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    const prompt = payload.executionRequest.prompt as string
    expect(prompt).toContain('[projectSpaceCapability]')
    expect(prompt).toContain('Use wework_space as the only interface')
    expect(prompt).toContain('Do not use git commands')
    expect(prompt).toContain('read_item_attachment')
  })

  test('does not inject project-space MCP instructions into automation execution prompts', async () => {
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
      taskId: 'task-project-automation',
      runtime: 'codex',
      message: 'Review cloud://projects/P-1/todos/T-1 using the supplied context.',
      origin: {
        type: 'project_automation',
        cloudProjectId: 'P-1',
        loopItemId: 'T-1',
        run_id: 'run-1',
      },
      additionalContext: {
        project: { kind: 'application', value: '{"id":"P-1","name":"Project"}' },
        task: { kind: 'application', value: '{"id":"T-1","title":"Review"}' },
        event: { kind: 'application', value: '{"type":"task.created"}' },
      },
    })

    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')?.[1]
    const prompt = payload.executionRequest.prompt as string
    expect(prompt).toContain('[project]')
    expect(prompt).toContain('[task]')
    expect(prompt).toContain('[event]')
    expect(prompt).not.toContain('[projectSpaceCapability]')
    expect(prompt).not.toContain('wework_space')
    expect(prompt).not.toContain('get_board_item')
    expect(prompt).not.toContain('list_spaces')
    expect(payload.executionRequest).toEqual(
      expect.objectContaining({
        task_id: 'task-project-automation',
        execution_target_type: 'local',
        device_id: 'device-uuid',
        new_session: true,
      })
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
      modelId: 'gpt-5.4',
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
            model_id: 'gpt-5.6-sol',
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

  test('normalizes local task supervisor requests before IPC', async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'task-1',
      supervisor: {
        mode: 'suggest',
        status: 'active',
        instructions: 'Keep scope focused',
        suggestions: [],
      },
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.setRuntimeSupervisor({
      address: { deviceId: 'local-device', taskId: 'task-1' },
      mode: 'suggest',
      instructions: 'Keep scope focused',
      modelSelection: {
        modelName: 'gpt-5.6-luna',
        modelType: 'public',
        options: {
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
        },
      },
      intervalSeconds: 60,
    })
    expect(request).toHaveBeenCalledWith('runtime.tasks.supervisor.set', {
      address: { deviceId: 'device-uuid', taskId: 'task-1' },
      mode: 'suggest',
      instructions: 'Keep scope focused',
      modelSelection: {
        modelName: 'gpt-5.6-luna',
        modelType: 'public',
        options: {
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
        },
      },
      intervalSeconds: 60,
    })

    await services.runtimeWorkApi?.setRuntimeSupervisor({
      address: { deviceId: 'local-device', taskId: 'task-1' },
      mode: 'auto',
      instructions: 'Keep scope focused',
      modelSelection: {
        modelName: 'gpt-5.6-sol',
        modelType: 'runtime',
        options: {
          reasoning: 'high',
        },
      },
      intervalSeconds: 30,
    })
    expect(request).toHaveBeenLastCalledWith(
      'runtime.tasks.supervisor.set',
      expect.objectContaining({
        address: { deviceId: 'device-uuid', taskId: 'task-1' },
        modelSelection: {
          modelName: 'gpt-5.6-sol',
          modelType: 'runtime',
          options: {
            reasoning: 'high',
          },
        },
        modelConfig: expect.objectContaining({
          model_id: 'gpt-5.6-sol',
          wework_model_kind: 'codex-official',
          reasoning: {
            effort: 'high',
          },
        }),
      })
    )

    await services.runtimeWorkApi?.runRuntimeSupervisorNow({
      address: { deviceId: 'local-device', taskId: 'task-1' },
    })
    expect(request).toHaveBeenCalledWith('runtime.tasks.supervisor.run_now', {
      address: { deviceId: 'device-uuid', taskId: 'task-1' },
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
          projectSource: 'local_project',
          projectAiSettings: {
            instructions: 'Run focused project tests.',
            modelSelection: {
              modelName: 'gpt-5.5',
              modelType: 'runtime',
              options: { reasoning: 'high' },
            },
            quickPhrases: [
              {
                id: 'project-review',
                title: 'Review project constraints',
                content: 'Read the project constraints first.',
                mode: 'plan',
              },
            ],
          },
          tasks: [
            {
              taskId: 'task-1',
              workspace_path: '/Users/me/worktrees/42/project',
              title: 'Build',
              runtime: 'codex',
              goal_status: 'active',
              continuable: true,
              thread_status: 'idle',
              turn_status: 'completed',
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
            source: 'local_project',
            stateDeviceId: 'device-uuid',
            roots: [{ kind: 'local', path: '/Users/me/project' }],
            pinned: false,
            pinnedOrder: null,
            active: false,
            appearance: null,
            aiSettings: {
              instructions: 'Run focused project tests.',
              modelSelection: {
                modelName: 'gpt-5.5',
                modelType: 'runtime',
                options: { reasoning: 'high' },
              },
              quickPhrases: [
                {
                  id: 'project-review',
                  title: 'Review project constraints',
                  content: 'Read the project constraints first.',
                  mode: 'plan',
                },
              ],
            },
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
                  goalStatus: 'active',
                  continuable: true,
                  threadStatus: 'idle',
                  turnStatus: 'completed',
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

  test('reads local workspace files through native commands', async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string, data: Record<string, unknown>) => {
        if (method !== 'device.execute_command') return {}
        if (data.command_key === 'workspace_write_text_file') {
          return {
            success: true,
            stdout: {
              path: '/Users/me/.canonical/project/README.md',
              name: 'README.md',
              content: data.stdin,
              editable: true,
              revision: 'sha256:new',
              truncated: false,
              size: 7,
              modified_at: '2026-06-20T01:01:00Z',
            },
            stderr: '',
            exit_code: 0,
          }
        }
        return { success: false, error: 'unexpected command', stderr: '', exit_code: 1 }
      })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/Users/me/project/README.md',
      name: 'README.md',
      content: 'hello',
      editable: true,
      revision: 'sha256:old',
      truncated: false,
      size: 5,
      modifiedAt: '2026-06-20T01:00:00Z',
    })
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
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
    const readWorkspaceFileChunk = vi.fn().mockResolvedValue({
      path: '/Users/me/.alias/project/image.png',
      name: 'image.png',
      contentBase64: 'aW1hZ2U=',
      offset: 0,
      eof: true,
      size: 5,
      modifiedAt: '2026-06-20T01:02:00Z',
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-uuid' }),
      request,
      subscribe: vi.fn(),
      readWorkspaceTextFile,
      readWorkspaceFileChunk,
      listWorkspaceEntries,
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
      services.deviceApi.readWorkspaceTextFile(
        'local-device',
        '/Users/me/project/README.md',
        '/Users/me/project'
      )
    ).resolves.toEqual({
      path: '/Users/me/project/README.md',
      name: 'README.md',
      content: 'hello',
      editable: true,
      revision: 'sha256:old',
      truncated: false,
      size: 5,
      modifiedAt: '2026-06-20T01:00:00Z',
    })
    await expect(
      services.deviceApi.writeWorkspaceTextFile(
        'local-device',
        '/Users/me/project/README.md',
        'updated',
        'sha256:old'
      )
    ).resolves.toEqual({
      path: '/Users/me/project/README.md',
      name: 'README.md',
      content: 'updated',
      editable: true,
      revision: 'sha256:new',
      truncated: false,
      size: 7,
      modifiedAt: '2026-06-20T01:01:00Z',
    })
    await expect(
      services.deviceApi.readWorkspaceFileChunk?.(
        'local-device',
        '/Users/me/.alias/project/image.png',
        0,
        '/Users/me/.alias/project'
      )
    ).resolves.toEqual({
      path: '/Users/me/.alias/project/image.png',
      name: 'image.png',
      contentBase64: 'aW1hZ2U=',
      offset: 0,
      eof: true,
      size: 5,
      modifiedAt: '2026-06-20T01:02:00Z',
    })

    expect(listWorkspaceEntries).toHaveBeenCalledWith('/Users/me/project', '/Users/me/project')
    expect(readWorkspaceTextFile).toHaveBeenCalledWith(
      '/Users/me/project',
      '/Users/me/project/README.md'
    )
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'workspace_write_text_file',
      path: '/Users/me/project',
      args: ['README.md', 'sha256:old'],
      stdin: 'updated',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 1024 * 2,
    })
    expect(readWorkspaceFileChunk).toHaveBeenCalledWith(
      '/Users/me/.alias/project',
      '/Users/me/.alias/project/image.png',
      0
    )
    expect(request).not.toHaveBeenCalledWith(
      'device.execute_command',
      expect.objectContaining({
        command_key: expect.stringMatching(/^workspace_read_/),
      })
    )
  })

  test('reverts local runtime file changes through the owning device command', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      stdout: { success: true, status: 'reverted' },
      stderr: '',
      error: null,
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'device-uuid',
        version: '1.9.0',
      }),
      request,
      subscribe: vi.fn(),
    })
    const fileChanges: TurnFileChangesSummary = {
      version: 1,
      status: 'active',
      artifact_id: 'turn-file-changes/codex/turn-1',
      device_id: 'device-uuid',
      workspace_path: '/Users/me/project',
      file_count: 1,
      additions: 1,
      deletions: 0,
      files: [
        {
          path: 'README.md',
          change_type: 'modified',
          additions: 1,
          deletions: 0,
          binary: false,
        },
      ],
      revertible: true,
    }

    const response = await services.runtimeWorkApi?.revertRuntimeFileChanges({
      address: {
        deviceId: 'device-uuid',
        taskId: 'runtime-1',
        workspacePath: '/Users/me/project',
      },
      fileChanges,
    })

    expect(response?.fileChanges).toMatchObject({
      status: 'reverted',
      artifact_id: fileChanges.artifact_id,
    })
    expect(request).toHaveBeenCalledWith('device.execute_command', {
      deviceId: 'device-uuid',
      command_key: 'turn_file_changes_revert',
      path: '/Users/me/project',
      args: ['turn-file-changes/codex/turn-1'],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('routes Worktree capabilities and preflight through the selected IPC device', async () => {
    const request = vi.fn().mockImplementation(async method => {
      if (method === 'runtime.worktrees.capabilities') {
        return {
          success: true,
          deviceId: 'remote-device',
          runtimeWorktrees: {
            version: 1,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        }
      }
      return {
        success: true,
        deviceId: 'remote-device',
        supported: true,
        sourcePath: '/workspace/project',
        sourceExists: true,
        sourceDirectory: true,
        gitRepository: true,
        gitCommonDirValid: true,
        gitCommonDirWritable: true,
        writable: true,
        repoRoot: '/workspace/project',
        resolvedWorktreeRoot: '/runtime/worktrees',
      }
    })
    const runtimeApi = createRuntimeWorkApiFromIpc(request, async () => 'remote-device', {
      resolveDeviceId: async () => 'remote-device',
      transportLabel: 'Cloud',
    })

    await runtimeApi.getWorktreeCapabilities({ deviceId: 'remote-device' })
    await runtimeApi.preflightWorktree({
      deviceId: 'remote-device',
      sourcePath: '/workspace/project',
    })

    expect(request).toHaveBeenCalledWith(
      'runtime.worktrees.capabilities',
      { deviceId: 'remote-device' },
      'remote-device'
    )
    expect(request).toHaveBeenCalledWith(
      'runtime.worktrees.preflight',
      {
        deviceId: 'remote-device',
        sourcePath: '/workspace/project',
      },
      'remote-device'
    )
  })
})
