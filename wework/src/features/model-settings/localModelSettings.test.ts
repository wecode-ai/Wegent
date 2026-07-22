import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalModelConfigs,
  deleteLocalModelConfig,
  listLocalModelConfigs,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  markLocalModelCatalogReady,
  reconcileLocalModelCatalogRuntime,
  saveLocalModelConfig,
} from './localModelSettings'

describe('localModelSettings', () => {
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
    expect(chat.toolProfile).toBe('function')
    expect(() =>
      saveLocalModelConfig({
        modelId: 'invalid-custom',
        baseUrl: 'https://chat.example/v1',
        apiFormat: 'openai-chat-completions',
        toolProfile: 'custom',
      })
    ).toThrow('Native custom tools require')
    expect(() =>
      saveLocalModelConfig({
        modelId: 'invalid-function',
        baseUrl: 'https://responses.example/v1',
        apiFormat: 'openai-responses',
        toolProfile: 'function',
      })
    ).toThrow('Function tool conversion requires')
  })

  beforeEach(() => {
    localStorage.clear()
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

  test('saves optional API key without requiring one', () => {
    const withoutKey = saveLocalModelConfig({
      id: 'ollama',
      displayName: 'Ollama GPT',
      group: '本地推理',
      modelId: 'gpt-oss:20b',
      baseUrl: ' http://localhost:11434/v1/ ',
      contextWindow: '128000',
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
      webSearchMode: 'disabled',
      imageGenerationEnabled: false,
      enabled: true,
    })
    expect(withoutKey.apiKey).toBeUndefined()
    expect(withKey.apiKey).toBe('local-secret')
    expect(listLocalModelConfigs()).toEqual([withoutKey, withKey])
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

  test('normalizes legacy request URL mode configs when reading storage', () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'legacy-default',
          displayName: 'Legacy Default',
          modelId: 'gpt-local',
          baseUrl: 'https://models.local/v1',
          requestUrlMode: 'responses_path',
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'legacy-custom',
          displayName: 'Legacy Custom',
          modelId: 'custom-model',
          baseUrl: 'https://models.local/api/respond',
          requestUrlMode: 'custom_url',
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )

    expect(listLocalModelConfigs()).toEqual([
      expect.objectContaining({
        id: 'legacy-default',
        apiFormat: 'openai-responses',
        baseUrl: 'https://models.local/v1',
        requestPath: '/responses',
      }),
      expect.objectContaining({
        id: 'legacy-custom',
        baseUrl: 'https://models.local/api',
        requestPath: '/respond',
      }),
    ])
  })

  test('migrates existing K3 configs to the built-in 256K catalog profile', () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'existing-k3',
          providerProfileId: 'kimi-coding',
          displayName: 'K3',
          modelId: 'k3',
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiFormat: 'openai-chat-completions',
          contextWindow: 256000,
          webSearchMode: 'disabled',
          imageGenerationEnabled: false,
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )

    expect(listLocalModelConfigs()).toEqual([
      expect.objectContaining({
        id: 'existing-k3',
        contextWindow: 262_144,
        codexCatalogModelId: 'wework-kimi-k3',
        catalogReady: true,
      }),
    ])
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
      catalogPendingRuntimeInstanceId: null,
    })
    expect(cleared).not.toHaveProperty('catalogEntry')
    expect(cleared).not.toHaveProperty('catalogPendingRuntimeInstanceId')
    expect(cleared.catalogReady).toBe(true)
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

  test('updates, deletes, clears, and emits change events', () => {
    const listener = vi.fn()
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, listener)

    try {
      const saved = saveLocalModelConfig({
        id: 'local-a',
        displayName: 'Local A',
        modelId: 'model-a',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: 'local-secret',
      })
      const updated = saveLocalModelConfig({
        id: saved.id,
        displayName: 'Local A Updated',
        modelId: 'model-a-new',
        baseUrl: 'http://localhost:1234/v1',
        webSearchMode: 'cached',
        imageGenerationEnabled: true,
        enabled: false,
      })

      expect(listLocalModelConfigs()).toHaveLength(1)
      expect(updated).toMatchObject({
        id: 'local-a',
        displayName: 'Local A Updated',
        modelId: 'model-a-new',
        webSearchMode: 'cached',
        imageGenerationEnabled: true,
        enabled: false,
      })

      expect(deleteLocalModelConfig('local-a')).toBe(true)
      expect(listLocalModelConfigs()).toEqual([])

      saveLocalModelConfig({
        id: 'local-b',
        displayName: 'Local B',
        modelId: 'model-b',
        baseUrl: 'http://localhost:4321/v1',
      })
      clearLocalModelConfigs()

      expect(listLocalModelConfigs()).toEqual([])
      expect(listener).toHaveBeenCalledTimes(5)
      expect(listener.mock.calls[0][0].detail.configs[0]).toMatchObject({
        id: 'local-a',
        apiKeyConfigured: true,
      })
      expect(listener.mock.calls[0][0].detail.configs[0]).not.toHaveProperty('apiKey')
    } finally {
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, listener)
    }
  })
})
