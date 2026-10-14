import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './localServices'
import {
  clearLocalModelConfigs,
  localModelName,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'

const gateway = 'https://wegent.example/api/runtime-work/llm-responses-proxy'
const selection = {
  modelName: 'deepseek-flash',
  modelType: 'public' as const,
  options: {
    weworkCloudModelNamespace: 'default',
    weworkCloudModelResourceUserId: '0',
  },
}
const address = {
  deviceId: 'device-1',
  taskId: 'task-1',
  workspacePath: '/tmp/project',
  runtimeHandle: {
    modelSelection: selection,
    executionRequest: { model_config: { model_id: 'deepseek-flash', base_url: gateway } },
  },
}

function services(apiKey?: string) {
  const request = vi.fn().mockResolvedValue({ accepted: true })
  const api = createLocalAppServices({
    ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-1' }),
    request,
    subscribe: vi.fn(),
    ...(apiKey ? { cloudModelGateway: { baseUrl: gateway, apiKey } } : {}),
  }).runtimeWorkApi!
  return { api, request }
}

describe('runtime context compaction model configuration', () => {
  beforeEach(() => {
    localStorage.clear()
    clearLocalModelConfigs()
    delete window.weworkElectronNetwork
  })

  test('rebuilds a redacted cloud profile with current credentials after restart', async () => {
    const resolveProxy = vi.fn().mockResolvedValue(null)
    window.weworkElectronNetwork = { resolveProxy }
    const before = JSON.stringify(address)
    for (const token of ['initial-login-token', 'refreshed-login-token']) {
      const { api, request } = services(token)
      await api.compactRuntimeTask({ address })
      const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.compact')![1]
      expect(payload).toMatchObject({
        taskId: 'task-1',
        modelConfig: {
          model_id: 'deepseek-flash',
          base_url: gateway,
          api_key: token,
          default_headers: {
            'X-Wegent-Model-Type': 'public',
            'X-Wegent-Model-Namespace': 'default',
            'X-Wegent-Model-User-Id': '0',
          },
        },
      })
      expect(payload.modelConfig.proxy).toBeUndefined()
    }
    expect(JSON.stringify(address)).toBe(before)
    expect(resolveProxy).toHaveBeenCalledWith(`${gateway}/responses`)
  })

  test('uses the resolved destination selection when the address handle is stale', async () => {
    const { api, request } = services('current-token')
    await api.compactRuntimeTask({
      address,
      modelSelection: { ...selection, modelName: 'destination-model' },
    })
    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.compact')![1]
    expect(payload.modelConfig.model_id).toBe('destination-model')
  })

  test('rebuilds a custom model from local settings and resolves its proxy', async () => {
    const localModel = saveLocalModelConfig({
      id: 'compact-model',
      displayName: 'Compact model',
      modelId: 'provider-model',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'current-provider-key',
      apiFormat: 'openai-responses',
      catalogReady: true,
    })
    const resolveProxy = vi.fn().mockResolvedValue('http://proxy.example:3128')
    window.weworkElectronNetwork = { resolveProxy }
    const { api, request } = services()
    await api.compactRuntimeTask({
      address,
      modelSelection: { modelName: localModelName(localModel), modelType: 'runtime', options: {} },
    })
    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.compact')![1]
    expect(payload.modelConfig).toMatchObject({
      model_id: 'provider-model',
      api_key: 'current-provider-key',
      proxy: { url: 'http://proxy.example:3128' },
    })
    expect(resolveProxy).toHaveBeenCalledWith('https://provider.example/v1/responses')
  })

  test('fails before dispatch when the cloud gateway is unavailable', async () => {
    const { api, request } = services()
    await expect(api.compactRuntimeTask({ address })).rejects.toThrow(
      'Cloud model gateway is not configured'
    )
    expect(request.mock.calls.some(([method]) => method === 'runtime.tasks.compact')).toBe(false)
  })

  test('fails before dispatch when the selected custom model was removed', async () => {
    const { api, request } = services()
    await expect(
      api.compactRuntimeTask({
        address,
        modelSelection: { modelName: 'local-model:removed', modelType: 'runtime', options: {} },
      })
    ).rejects.toThrow('Local model is no longer configured')
    expect(request.mock.calls.some(([method]) => method === 'runtime.tasks.compact')).toBe(false)
  })

  test('preserves native thread configuration when there is no model override', async () => {
    const { api, request } = services()
    await api.compactRuntimeTask({ address: { ...address, runtimeHandle: {} } })
    const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.compact')![1]
    expect(payload).not.toHaveProperty('modelConfig')
  })
})
