// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ModelSpecConfig } from '@/apis/models'
import {
  canEditModelSpecWithForm,
  extractThinkingConfig,
  extractUnmanagedModelEnv,
  formatModelSpec,
  mergeFormManagedSpec,
  validateModelSpecJson,
} from '@/features/settings/components/model-config'

const originalSpec: ModelSpecConfig = {
  modelConfig: {
    env: {
      model: 'openai',
      model_id: 'old-model',
      api_key: 'old-secret',
      supports_developer_role: false,
      retry_policy: { attempts: 0 },
    },
    context_window: 32000,
    futureRuntime: { enabled: false },
  },
  protocol: 'openai',
  modelType: 'llm',
  costIndex: '1',
  futureSpecOption: { mode: 'strict' },
}

describe('model spec configuration', () => {
  it('formats and validates a complete model spec', () => {
    expect(validateModelSpecJson(formatModelSpec(originalSpec))).toEqual({
      value: originalSpec,
      error: null,
      paths: [],
    })
  })

  it.each([
    ['not-json', 'invalid_json'],
    ['[]', 'invalid_object'],
    ['null', 'invalid_object'],
    ['{}', 'invalid_model_config'],
    ['{"modelConfig":[]}', 'invalid_model_config'],
  ])('rejects invalid model spec %s', (value, error) => {
    expect(validateModelSpecJson(value)).toMatchObject({ value: null, error })
  })

  it('rejects unsafe keys recursively and reports paths without values', () => {
    const result = validateModelSpecJson(
      '{"modelConfig":{"env":{"nested":{"constructor":{"api_key":"secret"}}}}}'
    )

    expect(result).toEqual({
      value: null,
      error: 'unsafe_keys',
      paths: ['spec.modelConfig.env.nested.constructor'],
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('replaces form-managed values while preserving unknown fields', () => {
    const managedSpec: ModelSpecConfig = {
      modelConfig: {
        env: {
          model: 'claude',
          model_id: 'new-model',
          api_key: 'new-secret',
        },
      },
      modelType: 'llm',
    }

    expect(mergeFormManagedSpec(originalSpec, managedSpec)).toEqual({
      modelConfig: {
        env: {
          supports_developer_role: false,
          retry_policy: { attempts: 0 },
          model: 'claude',
          model_id: 'new-model',
          api_key: 'new-secret',
        },
        futureRuntime: { enabled: false },
      },
      modelType: 'llm',
      futureSpecOption: { mode: 'strict' },
    })
  })

  it('removes cleared form-managed fields without deleting unknown fields', () => {
    const managedSpec: ModelSpecConfig = {
      modelConfig: {
        env: {
          model: 'openai',
          model_id: 'old-model',
          api_key: 'old-secret',
        },
      },
      modelType: 'llm',
    }

    const merged = mergeFormManagedSpec(originalSpec, managedSpec)
    expect(merged).not.toHaveProperty('costIndex')
    expect(merged.modelConfig).not.toHaveProperty('context_window')
    expect(merged).toHaveProperty('futureSpecOption')
    expect(merged.modelConfig).toHaveProperty('futureRuntime')
  })

  it('preserves unknown fields inside the active type configuration', () => {
    const originalVideoSpec: ModelSpecConfig = {
      ...originalSpec,
      modelType: 'video',
      videoConfig: {
        duration: 5,
        futureVideoOption: { mode: 'fast' },
      },
    }
    const managedVideoSpec: ModelSpecConfig = {
      modelConfig: originalSpec.modelConfig,
      modelType: 'video',
      videoConfig: { duration: 10 },
    }

    expect(mergeFormManagedSpec(originalVideoSpec, managedVideoSpec).videoConfig).toEqual({
      futureVideoOption: { mode: 'fast' },
      duration: 10,
    })
  })

  it('preserves future nested capability fields and drops cleared managed fields', () => {
    const originalImageSpec: ModelSpecConfig = {
      ...originalSpec,
      modelType: 'image',
      imageConfig: {
        size: '2048x2048',
        capabilities: {
          supports_image_input: true,
          futureCapability: { enabled: false },
        },
      },
    }
    const managedImageSpec: ModelSpecConfig = {
      modelConfig: originalSpec.modelConfig,
      modelType: 'image',
      imageConfig: { size: '1024x1024' },
    }

    expect(mergeFormManagedSpec(originalImageSpec, managedImageSpec).imageConfig).toEqual({
      size: '1024x1024',
      capabilities: { futureCapability: { enabled: false } },
    })
  })

  it('preserves future fields from inactive type configurations', () => {
    const originalTtsSpec: ModelSpecConfig = {
      ...originalSpec,
      modelType: 'tts',
      ttsConfig: { speed: 1, futureVoiceOption: 'kept' },
    }
    const managedLlmSpec: ModelSpecConfig = {
      modelConfig: originalSpec.modelConfig,
      modelType: 'llm',
    }

    expect(mergeFormManagedSpec(originalTtsSpec, managedLlmSpec).ttsConfig).toEqual({
      futureVoiceOption: 'kept',
    })
  })

  it('detects specs that the visual form cannot represent', () => {
    expect(canEditModelSpecWithForm(originalSpec)).toBe(true)
    expect(
      canEditModelSpecWithForm({ modelConfig: { env: null } } as unknown as ModelSpecConfig)
    ).toBe(false)
  })

  it('extracts unmanaged env and wrapped thinking configuration', () => {
    expect(extractUnmanagedModelEnv(originalSpec)).toEqual({
      supports_developer_role: false,
      retry_policy: { attempts: 0 },
    })
    expect(
      extractThinkingConfig({
        thinking_config: { thinking_config: { effort: 'high', enabled: false } },
      })
    ).toEqual({ effort: 'high', enabled: false })
  })
})
