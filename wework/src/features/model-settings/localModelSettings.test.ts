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
      enabled: true,
    })
    expect(withoutKey.apiKey).toBeUndefined()
    expect(withKey.apiKey).toBe('local-secret')
    expect(listLocalModelConfigs()).toEqual([withoutKey, withKey])
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
        enabled: false,
      })

      expect(listLocalModelConfigs()).toHaveLength(1)
      expect(updated).toMatchObject({
        id: 'local-a',
        displayName: 'Local A Updated',
        modelId: 'model-a-new',
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
