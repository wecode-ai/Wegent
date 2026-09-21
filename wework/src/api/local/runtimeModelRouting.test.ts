import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './localServices'
import { CODEX_API_URL, resolveLocalCodexProxyUrl } from '@/desktop/systemProxy'
import {
  clearLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'

const gateway = 'https://wegent.example/api/runtime-work/llm-responses-proxy'
const cloudModel = {
  modelId: 'cloud-model',
  modelType: 'user',
  modelOptions: { weworkCloudModelNamespace: 'default', weworkCloudModelResourceUserId: '42' },
}
const ready = { running: true, ready: true, deviceId: 'device-1' }

describe('local model requests with PAC', () => {
  beforeEach(() => {
    localStorage.clear()
    clearLocalModelConfigs()
    delete window.weworkElectronNetwork
  })

  test('keeps cloud create and follow-up direct while the title model uses the ChatGPT proxy', async () => {
    const resolveProxy = vi.fn(async (url: string) =>
      url === CODEX_API_URL ? 'http://external-proxy:3128' : null
    )
    window.weworkElectronNetwork = { resolveProxy }
    // Reproduce startup resolving a proxy for ChatGPT before a cloud task is created.
    await resolveLocalCodexProxyUrl()
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue(ready),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: { baseUrl: gateway, apiKey: 'test-token' },
    })
    await services.runtimeWorkApi!.createRuntimeTask({
      deviceId: 'device-1',
      workspacePath: '/tmp/project',
      taskId: 'pac-task',
      runtime: 'codex',
      message: 'hello',
      title: 'PAC',
      ...cloudModel,
      friendlyTitle: { modelId: 'gpt-5.4', modelType: 'runtime' },
    })
    await services.runtimeWorkApi!.sendRuntimeMessage({
      address: { deviceId: 'device-1', workspacePath: '/tmp/project', taskId: 'pac-task' },
      message: 'continue',
      ...cloudModel,
    })
    const create = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')![1]
    const send = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')![1]
    expect(create.executionRequest.model_config.proxy).toBeUndefined()
    expect(send.executionRequest.model_config.proxy).toBeUndefined()
    expect(create.friendlyTitleExecutionRequest.model_config.proxy).toEqual({
      url: 'http://external-proxy:3128',
    })
    expect(resolveProxy.mock.calls.filter(([url]) => url === `${gateway}/responses`)).toHaveLength(
      2
    )
  })

  test('keeps local project continuation local even with an old cloud Team handle', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const materializeRuntimeTask = vi
      .fn()
      .mockRejectedValue(new Error('Backend must not be called'))
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue(ready),
      request,
      subscribe: vi.fn(),
      materializeRuntimeTask,
    })
    const origin = {
      type: 'project_automation' as const,
      projectStore: 'local' as const,
      cloudProjectId: 'local-project',
      loopItemId: 'local-issue',
    }
    await services.runtimeWorkApi!.sendRuntimeMessage({
      address: {
        deviceId: 'device-1',
        workspacePath: '/tmp/project',
        taskId: 'local-task',
        runtime: 'claude_code',
        runtimeHandle: { origin, wegentTeam: { id: 17 } },
      },
      message: 'continue',
    })
    expect(materializeRuntimeTask).not.toHaveBeenCalled()
    const sent = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')![1]
    expect(sent.executionRequest.origin).toEqual(origin)
    expect(sent.executionRequest.backend_url).toBeUndefined()
    expect(sent.executionRequest.auth_token).toBeUndefined()
  })

  test('resolves a custom model request path again after PAC changes', async () => {
    saveLocalModelConfig({
      id: 'pac-custom',
      displayName: 'PAC custom',
      modelId: 'custom',
      baseUrl: 'https://custom.example/v1',
      requestPath: '/custom-responses',
      apiFormat: 'openai-responses',
      catalogReady: true,
    })
    const resolveProxy = vi
      .fn()
      .mockResolvedValueOnce('http://proxy-one:3128')
      .mockResolvedValueOnce(null)
    window.weworkElectronNetwork = { resolveProxy }
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue(ready),
      request,
      subscribe: vi.fn(),
    })
    await services.runtimeWorkApi!.createRuntimeTask({
      deviceId: 'device-1',
      workspacePath: '/tmp/project',
      taskId: 'custom-task',
      runtime: 'codex',
      message: 'hello',
      title: 'PAC',
      modelId: 'local-model:pac-custom',
    })
    await services.runtimeWorkApi!.sendRuntimeMessage({
      address: { deviceId: 'device-1', workspacePath: '/tmp/project', taskId: 'custom-task' },
      message: 'continue',
      modelId: 'local-model:pac-custom',
    })
    const create = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')![1]
    const send = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')![1]
    expect(create.executionRequest.model_config.proxy).toEqual({ url: 'http://proxy-one:3128' })
    expect(send.executionRequest.model_config.proxy).toBeUndefined()
    expect(resolveProxy.mock.calls).toEqual([
      ['https://custom.example/v1/custom-responses'],
      ['https://custom.example/v1/custom-responses'],
    ])
  })

  test('registers a standalone harness using its own PAC route', async () => {
    saveLocalModelConfig({
      id: 'harness-pac',
      displayName: 'Harness PAC',
      modelId: 'custom',
      baseUrl: 'https://internal.example/v1',
      apiFormat: 'anthropic-messages',
      requestPath: '/messages',
      apiKey: 'test-key',
    })
    const resolveProxy = vi.fn(async (url: string) =>
      url === CODEX_API_URL ? 'http://external-proxy:3128' : null
    )
    window.weworkElectronNetwork = { resolveProxy }
    await resolveLocalCodexProxyUrl()
    const request = vi.fn().mockResolvedValue({
      token: 'test-token',
      baseUrl: 'http://127.0.0.1:1234/v1/harness-router/test-token',
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue(ready),
      request,
      subscribe: vi.fn(),
    })
    await services.localHarnessModelApi!.resolveLaunch('claude_code', {
      key: 'harness-pac',
      label: 'Harness PAC',
      source: 'local',
      model: {
        name: 'local-model:harness-pac',
        type: 'runtime',
        provider: 'local',
        modelId: 'custom',
        config: { weworkModelKind: 'model-interface' },
      },
    })
    expect(resolveProxy).toHaveBeenLastCalledWith('https://internal.example/v1/messages')
    expect(request).toHaveBeenCalledWith(
      'runtime.harness_proxy.register',
      expect.objectContaining({
        upstream: expect.objectContaining({ proxy_url: null }),
      })
    )
  })

  test('does not dispatch a model request when PAC resolution fails', async () => {
    window.weworkElectronNetwork = {
      resolveProxy: vi.fn().mockRejectedValue(new Error('PAC resolution failed')),
    }
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue(ready),
      request,
      subscribe: vi.fn(),
      cloudModelGateway: { baseUrl: gateway, apiKey: 'test-token' },
    })
    await expect(
      services.runtimeWorkApi!.createRuntimeTask({
        deviceId: 'device-1',
        workspacePath: '/tmp/project',
        taskId: 'pac-task',
        runtime: 'codex',
        message: 'hello',
        title: 'PAC',
        ...cloudModel,
      })
    ).rejects.toThrow('PAC resolution failed')
    expect(request.mock.calls.some(([method]) => method === 'runtime.tasks.create')).toBe(false)
  })
})
