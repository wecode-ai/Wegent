import { clearLocalModelConfigs, saveLocalModelConfig } from '@/test/model-config-fixtures'
import { replaceProviderModelConfigs } from './providerModelState'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  findLocalModelConfigByModelName,
  listLocalModelConfigs,
  localModelName,
  markLocalModelCatalogReady,
  reconcileLocalModelCatalogRuntime,
} from './localModelSettings'

describe('localModelSettings', () => {
  test('validates output budgets and allows clearing the limit', () => {
    const input = {
      id: 'output-budget',
      modelId: 'custom',
      baseUrl: 'https://models.example/v1',
      contextWindow: 128000,
    }
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 128000, 128001]) {
      expect(() => saveLocalModelConfig({ ...input, maxOutputTokens: value })).toThrow()
    }
    saveLocalModelConfig({ ...input, maxOutputTokens: '16000' })
    expect(listLocalModelConfigs()[0].maxOutputTokens).toBe(16000)
    saveLocalModelConfig({ ...input, maxOutputTokens: '' })
    expect(listLocalModelConfigs()[0].maxOutputTokens).toBeUndefined()
  })
  test('defaults tool profiles by API format and rejects incompatible combinations', () => {
    const responses = saveLocalModelConfig({
      modelId: 'responses-model',
      baseUrl: 'https://responses.example/v1',
      apiFormat: 'openai-responses',
    })
    const chat = saveLocalModelConfig({
      modelId: 'chat-model',
      baseUrl: 'https://chat.example/v1',
      apiFormat: 'openai-chat-completions',
    })

    expect(responses.toolProfile).toBe('custom')
    expect(responses.codexToolCompatibility).toBe('native')
    expect(chat.toolProfile).toBe('function')
    expect(chat.codexToolCompatibility).toBe('standard')
    expect(() =>
      saveLocalModelConfig({
        modelId: 'invalid-custom',
        baseUrl: 'https://chat.example/v1',
        apiFormat: 'openai-chat-completions',
        toolProfile: 'custom',
      })
    ).toThrow('Native custom tools require')
    const functionResponses = saveLocalModelConfig({
      modelId: 'function-responses',
      baseUrl: 'https://responses.example/v1',
      apiFormat: 'openai-responses',
      toolProfile: 'function',
    })
    expect(functionResponses.toolProfile).toBe('function')
  })

  test('persists an explicit standard Responses compatibility override', () => {
    const model = saveLocalModelConfig({
      modelId: 'azure-responses-model',
      baseUrl: 'https://azure.example/openai/v1',
      apiFormat: 'openai-responses',
      codexToolCompatibility: 'standard',
    })

    expect(model.codexToolCompatibility).toBe('standard')
    expect(listLocalModelConfigs()[0].codexToolCompatibility).toBe('standard')
  })

  beforeEach(() => {
    localStorage.clear()
    clearLocalModelConfigs()
  })

  test('validates URL and model ID before saving', () => {
    expect(() =>
      saveLocalModelConfig({
        id: 'bad-url',
        displayName: 'Bad URL',
        modelId: 'gpt-local',
        baseUrl: 'localhost:11434/v1',
      })
    ).toThrow('Model URL must be a valid HTTP URL')

    expect(() =>
      saveLocalModelConfig({
        id: 'bad-model',
        displayName: 'Bad Model',
        modelId: '   ',
        baseUrl: 'http://localhost:11434/v1',
      })
    ).toThrow('Model ID is required')
  })

  test('normalizes optional keys in memory without a browser persistence path', () => {
    const withoutKey = saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      group: '本地推理',
      modelId: 'gpt-oss:20b',
      baseUrl: ' http://localhost:11434/v1/ ',
      contextWindow: '128000',
      maxOutputTokens: '16000',
      enabled: true,
    })
    const withKey = saveLocalModelConfig({
      id: 'lmstudio',
      displayName: 'LM Studio',
      modelId: 'qwen3-coder',
      baseUrl: 'https://models.local/v1',
      apiKey: ' local-secret ',
    })

    expect(withoutKey).toMatchObject({
      id: 'ollama',
      displayName: 'Ollama GPT',
      group: '本地推理',
      modelId: 'gpt-oss:20b',
      baseUrl: 'http://localhost:11434/v1',
      contextWindow: 128000,
      maxOutputTokens: 16000,
      webSearchMode: 'disabled',
      imageGenerationEnabled: false,
      enabled: true,
    })
    expect(withoutKey.apiKey).toBeUndefined()
    expect(withKey.apiKey).toBe('local-secret')
    expect(listLocalModelConfigs()).toEqual([withoutKey, withKey])
    expect(localStorage.getItem('wework.localModelSettings.v1')).toBeNull()
  })

  test('finds a custom model by its local and Codex catalog names', () => {
    const model = saveLocalModelConfig({
      id: 'custom-responses',
      displayName: 'Custom Responses',
      modelId: 'responses-model',
      baseUrl: 'https://responses.example/v1',
    })

    expect(findLocalModelConfigByModelName(localModelName(model))).toEqual(model)
    expect(findLocalModelConfigByModelName(model.codexCatalogModelId)).toEqual(model)
  })

  test('does not resolve a local model when the model name is absent', () => {
    const vision = saveLocalModelConfig({
      id: 'vision',
      displayName: 'Vision',
      modelId: 'vision-model',
      baseUrl: 'https://vision.example/v1',
      catalogEntry: {
        input_modalities: ['text', 'image'],
      },
    })

    expect(vision.codexCatalogModelId).toBeUndefined()
    expect(findLocalModelConfigByModelName()).toBeNull()
  })

  test('retains vision proxy metadata in the native runtime projection', () => {
    const vision = saveLocalModelConfig({
      id: 'vision',
      displayName: 'Vision',
      modelId: 'vision-model',
      baseUrl: 'https://vision.example/v1',
      catalogEntry: {
        input_modalities: ['text', 'image'],
      },
    })
    const primary = saveLocalModelConfig({
      id: 'deepseek',
      providerProfileId: 'deepseek',
      displayName: 'DeepSeek',
      modelId: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      visionModelConfigId: vision.id,
    })

    expect(primary.visionModelConfigId).toBe('vision')
    expect(primary.codexCatalogModelId).toBe('wework-deepseek-v4-flash')
    replaceProviderModelConfigs([vision, primary])
    expect(listLocalModelConfigs()[1].visionModelConfigId).toBe(vision.id)
  })

  test('rejects a missing, disabled, or self-referencing vision proxy', () => {
    expect(() =>
      saveLocalModelConfig({
        id: 'self',
        modelId: 'self',
        baseUrl: 'https://models.example/v1',
        visionModelConfigId: 'self',
      })
    ).toThrow('must be different')

    const disabled = saveLocalModelConfig({
      id: 'disabled-vision',
      modelId: 'vision',
      baseUrl: 'https://vision.example/v1',
      enabled: false,
    })
    expect(() =>
      saveLocalModelConfig({
        id: 'primary',
        modelId: 'primary',
        baseUrl: 'https://models.example/v1',
        visionModelConfigId: disabled.id,
      })
    ).toThrow('missing or disabled')
  })

  test('rejects disabling a vision proxy that is still referenced', () => {
    saveLocalModelConfig({
      id: 'vision',
      modelId: 'vision-model',
      baseUrl: 'https://vision.example/v1',
    })
    saveLocalModelConfig({
      id: 'primary',
      modelId: 'primary-model',
      baseUrl: 'https://models.example/v1',
      visionModelConfigId: 'vision',
    })

    expect(() =>
      saveLocalModelConfig({
        id: 'vision',
        modelId: 'vision-model',
        baseUrl: 'https://vision.example/v1',
        enabled: false,
      })
    ).toThrow('still referenced')
    expect(listLocalModelConfigs().find(config => config.id === 'vision')?.enabled).toBe(true)
  })

  test('never loads restored plaintext credentials into the runtime catalog', () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'legacy-secret',
          displayName: 'Legacy secret',
          modelId: 'legacy-model',
          baseUrl: 'https://models.local/v1',
          apiKey: 'legacy-api-key',
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )

    expect(listLocalModelConfigs()).toEqual([])
    markLocalModelCatalogReady([])
    reconcileLocalModelCatalogRuntime('runtime-2')
    expect(listLocalModelConfigs()).toEqual([])
    expect(localStorage.getItem('wework.localModelSettings.v1')).toContain('legacy-api-key')
  })

  test('normalizes full responses endpoint to model base URL', () => {
    const saved = saveLocalModelConfig({
      id: 'full-endpoint',
      displayName: 'Full Endpoint',
      modelId: 'gpt-local',
      baseUrl: 'https://models.local/v1/responses',
    })

    expect(saved.baseUrl).toBe('https://models.local/v1')
    expect(saved.requestPath).toBe('/responses')
    expect(saved.apiFormat).toBe('openai-responses')
  })

  test('stores Chat Completions format and applies its default endpoint', () => {
    const saved = saveLocalModelConfig({
      id: 'kimi-chat',
      providerProfileId: 'kimi-coding',
      displayName: 'Kimi Chat',
      modelId: 'kimi-for-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiFormat: 'openai-chat-completions',
    })

    expect(saved).toMatchObject({
      providerProfileId: 'kimi-coding',
      apiFormat: 'openai-chat-completions',
      baseUrl: 'https://api.kimi.com/coding/v1',
      requestPath: '/chat/completions',
    })
  })

  test('stores Anthropic Messages format and applies its default endpoint', () => {
    const saved = saveLocalModelConfig({
      id: 'kimi-messages',
      displayName: 'Kimi Messages',
      modelId: 'kimi-for-coding',
      baseUrl: 'https://api.kimi.com/coding/',
      apiFormat: 'anthropic-messages',
    })

    expect(saved).toMatchObject({
      apiFormat: 'anthropic-messages',
      baseUrl: 'https://api.kimi.com/coding',
      requestPath: '/v1/messages',
    })
  })

  test('splits custom request URLs into base URL and request path', () => {
    const saved = saveLocalModelConfig({
      id: 'custom-url',
      displayName: 'Custom URL',
      modelId: 'gpt-local',
      baseUrl: 'https://models.local/api/respond',
    })

    expect(saved).toMatchObject({
      baseUrl: 'https://models.local/api',
      requestPath: '/respond',
    })
  })

  test('preserves explicit custom request paths', () => {
    const saved = saveLocalModelConfig({
      id: 'custom-path',
      displayName: 'Custom Path',
      modelId: 'gpt-local',
      baseUrl: 'https://models.local/v1',
      requestPath: 'custom-responses',
    })

    expect(saved).toMatchObject({
      baseUrl: 'https://models.local/v1',
      requestPath: '/custom-responses',
    })
  })

  test('validates optional context window before saving', () => {
    expect(() =>
      saveLocalModelConfig({
        id: 'bad-context',
        displayName: 'Bad Context',
        modelId: 'gpt-local',
        baseUrl: 'http://localhost:11434/v1',
        contextWindow: '12.5',
      })
    ).toThrow('Context window must be a positive integer')

    expect(() =>
      saveLocalModelConfig({
        id: 'zero-context',
        displayName: 'Zero Context',
        modelId: 'gpt-local',
        baseUrl: 'http://localhost:11434/v1',
        contextWindow: 0,
      })
    ).toThrow('Context window must be a positive integer')
  })

  test('makes pending catalog models ready after the executor instance changes', () => {
    saveLocalModelConfig({
      id: 'pending-model',
      displayName: 'Pending model',
      modelId: 'pending-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: false,
      catalogPendingRuntimeInstanceId: 'runtime-1',
    })

    reconcileLocalModelCatalogRuntime('runtime-1')
    expect(listLocalModelConfigs()[0]).toMatchObject({ catalogReady: false })

    reconcileLocalModelCatalogRuntime('runtime-2')
    expect(listLocalModelConfigs()[0]).toMatchObject({ catalogReady: true })
    expect(listLocalModelConfigs()[0]).not.toHaveProperty('catalogPendingRuntimeInstanceId')
  })

  test('preserves pending state and honors explicit catalog clearing', () => {
    const initial = saveLocalModelConfig({
      id: 'custom-model',
      modelId: 'custom-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogPendingRuntimeInstanceId: 'runtime-1',
    })
    expect(initial.catalogReady).toBe(false)

    const unchanged = saveLocalModelConfig({
      id: initial.id,
      modelId: initial.modelId,
      baseUrl: initial.baseUrl,
    })
    expect(unchanged.catalogPendingRuntimeInstanceId).toBe('runtime-1')

    const cleared = saveLocalModelConfig({
      id: initial.id,
      providerProfileId: 'kimi-coding',
      modelId: initial.modelId,
      baseUrl: initial.baseUrl,
      catalogEntry: null,
    })
    expect(cleared).not.toHaveProperty('catalogEntry')
    expect(cleared).not.toHaveProperty('catalogPendingRuntimeInstanceId')
    expect(cleared.catalogReady).toBe(true)

    const pendingChange = saveLocalModelConfig({
      id: 'changed-model',
      modelId: 'changed-model',
      baseUrl: initial.baseUrl,
      catalogPendingRuntimeInstanceId: 'runtime-1',
    })
    const changed = saveLocalModelConfig({
      id: pendingChange.id,
      modelId: pendingChange.modelId,
      baseUrl: pendingChange.baseUrl,
      catalogEntry: {
        ...pendingChange.catalogEntry,
        description: 'Changed catalog metadata',
      },
    })
    expect(changed).not.toHaveProperty('catalogPendingRuntimeInstanceId')
  })

  test('marks only the catalog snapshot that was written as ready', () => {
    const written = saveLocalModelConfig({
      id: 'written-model',
      modelId: 'written-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: false,
    })
    const concurrent = saveLocalModelConfig({
      id: 'concurrent-model',
      modelId: 'concurrent-model',
      baseUrl: 'http://localhost:11434/v1',
      catalogReady: false,
    })

    markLocalModelCatalogReady([written])

    expect(listLocalModelConfigs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: written.id, catalogReady: true }),
        expect.objectContaining({ id: concurrent.id, catalogReady: false }),
      ])
    )
  })

  test('uses a monotonic revision for rapid saves of the same model', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      const written = saveLocalModelConfig({
        id: 'rapid-model',
        modelId: 'rapid-model',
        baseUrl: 'http://localhost:11434/v1',
        catalogReady: false,
      })
      const newer = saveLocalModelConfig({
        id: written.id,
        modelId: written.modelId,
        baseUrl: written.baseUrl,
        catalogReady: false,
      })

      expect(newer.updatedAt).not.toBe(written.updatedAt)
      markLocalModelCatalogReady([written])
      expect(listLocalModelConfigs()[0].catalogReady).toBe(false)
    } finally {
      now.mockRestore()
    }
  })
})
