import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalModelConfigs,
  deleteLocalModelConfig,
  listLocalModelConfigs,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  saveLocalModelConfig,
} from './localModelSettings'

describe('localModelSettings', () => {
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
      displayName: 'Kimi Chat',
      modelId: 'kimi-for-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiFormat: 'openai-chat-completions',
    })

    expect(saved).toMatchObject({
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
