import { describe, expect, test } from 'vitest'
import type { RuntimeContextUsage, UnifiedModel } from '@/types/api'
import {
  applyModelContextWindowOverride,
  findModelForSelection,
  modelContextWindowFromConfig,
} from './runtimeContextUsage'

const baseUsage: RuntimeContextUsage = {
  total: {
    totalTokens: 43_300,
    inputTokens: 43_000,
    cachedInputTokens: 0,
    outputTokens: 300,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: 43_300,
    inputTokens: 43_000,
    cachedInputTokens: 0,
    outputTokens: 300,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 258_400,
}

function model(
  config: Record<string, unknown>,
  overrides: Partial<UnifiedModel> = {}
): UnifiedModel {
  return {
    name: 'local-model',
    type: 'user',
    config,
    ...overrides,
  }
}

describe('runtimeContextUsage', () => {
  test('reads context window from supported model config keys', () => {
    expect(modelContextWindowFromConfig(model({ model_context_window: 1_000_000 }))).toBe(1_000_000)
    expect(modelContextWindowFromConfig(model({ context_window: '128000' }))).toBe(128_000)
    expect(modelContextWindowFromConfig(model({ contextWindow: 'bad-value' }))).toBeNull()
  })

  test('overrides runtime reported context window with configured model window', () => {
    expect(
      applyModelContextWindowOverride(baseUsage, model({ model_context_window: 1_000_000 }))
        .modelContextWindow
    ).toBe(1_000_000)
  })

  test('finds selected model by name and type', () => {
    const models = [
      model({ model_context_window: 128_000 }, { name: 'shared-model', type: 'public' }),
      model({ model_context_window: 1_000_000 }, { name: 'shared-model', type: 'user' }),
    ]

    expect(
      findModelForSelection(models, { modelName: 'shared-model', modelType: 'user' })?.config
    ).toEqual({ model_context_window: 1_000_000 })
  })
})
