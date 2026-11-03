// @vitest-environment node

import type { RuntimeContextUsage, UnifiedModel } from '@/types/api'
import { runtimeContextUsageMetrics } from '@wegent/chat-core/runtime-context-usage'
import { describe, expect, test } from 'vitest'
import {
  applyModelContextWindowOverride,
  findModelForSelection,
  modelContextWindowFromConfig,
  modelInputTokenBudget,
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
  test.each(['anthropic-messages'])(
    'uses the shared Catalog input budget for %s with no configured window',
    upstreamApiFormat => {
      const configured = model({
        codex_catalog_model_id: 'wework-gpt-6.1-sol',
        protocol: 'openai-responses',
        upstreamApiFormat,
      })
      expect(modelContextWindowFromConfig(configured)).toBeNull()
      expect(modelInputTokenBudget(configured)).toBe(176_000)
      const usage = applyModelContextWindowOverride(
        { ...baseUsage, last: { ...baseUsage.last, totalTokens: 140_800 } },
        configured
      )
      expect(runtimeContextUsageMetrics(usage)?.usedPercent).toBe(80)
      expect(
        applyModelContextWindowOverride({ ...baseUsage, modelContextWindow: 128_000 }, configured)
          .modelContextWindow
      ).toBe(128_000)
      expect(
        modelInputTokenBudget({
          ...configured,
          config: { ...configured.config, max_output_tokens: 8_000 },
        })
      ).toBe(264_000)
    }
  )

  test.each(['codex-official'])(
    'does not apply a Wework compatibility Catalog to a native %s model',
    weworkModelKind => {
      const configured = model(
        { protocol: 'openai-responses', weworkModelKind },
        { type: 'runtime', provider: 'local', modelId: 'gpt-6.1-sol' }
      )
      const usage = { ...baseUsage, modelContextWindow: 1_000_000 }
      expect(modelInputTokenBudget(configured)).toBeNull()
      expect(applyModelContextWindowOverride(usage, configured)).toBe(usage)
    }
  )

  test('uses persisted provider identity when runtime models share a name', () => {
    const models = [
      model(
        { codexProviderId: 'openai' },
        { name: 'gpt-5.6-luna', type: 'runtime', provider: 'local' }
      ),
      model(
        { codexProviderId: 'wework-e2e' },
        { name: 'gpt-5.6-luna', type: 'runtime', provider: 'local' }
      ),
    ]

    expect(
      findModelForSelection(models, {
        modelName: 'gpt-5.6-luna',
        modelType: 'runtime',
        options: { codexProviderId: 'wework-e2e', collaborationMode: 'plan' },
      })?.config
    ).toEqual({ codexProviderId: 'wework-e2e' })
  })

  test('does not fall back to another provider when persisted identity is unavailable', () => {
    const models = [
      model(
        { codexProviderId: 'openai' },
        { name: 'gpt-5.6-luna', type: 'runtime', provider: 'local' }
      ),
    ]

    expect(
      findModelForSelection(models, {
        modelName: 'gpt-5.6-luna',
        modelType: 'runtime',
        options: { codexProviderId: 'wework-e2e' },
      })
    ).toBeNull()
  })
})
