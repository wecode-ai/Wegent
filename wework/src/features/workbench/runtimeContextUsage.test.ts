import { describe, expect, test } from 'vitest'
import type { RuntimeContextUsage, UnifiedModel } from '@/types/api'
import { runtimeContextUsageMetrics } from '@wegent/chat-core/runtime-context-usage'
import {
  applyModelContextWindowOverride,
  findModelForSelection,
  modelContextWindowFromConfig,
  modelInputTokenBudget,
  modelMaxOutputTokensFromConfig,
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

  test('does not raise a smaller runtime reported context window', () => {
    expect(
      applyModelContextWindowOverride(baseUsage, model({ model_context_window: 1_000_000 }))
        .modelContextWindow
    ).toBe(258_400)
  })

  test('uses the smaller of the runtime window and the model input budget', () => {
    expect(
      applyModelContextWindowOverride(
        { ...baseUsage, modelContextWindow: 996_147 },
        model({ context_window: 1_048_576, max_output_tokens: 96_000 })
      ).modelContextWindow
    ).toBe(952_576)
  })

  test('reads max output tokens from supported model config keys', () => {
    expect(modelMaxOutputTokensFromConfig(model({ max_output_tokens: 384_000 }))).toBe(384_000)
    expect(modelMaxOutputTokensFromConfig(model({ maxOutputTokens: '384000' }))).toBe(384_000)
    expect(modelMaxOutputTokensFromConfig(model({ max_output_tokens: 0 }))).toBeNull()
  })

  test('reserves the configured output budget from the input token budget', () => {
    expect(
      modelInputTokenBudget(model({ context_window: 1_000_000, max_output_tokens: 384_000 }))
    ).toBe(616_000)
  })

  test.each(['openai-chat-completions', 'anthropic-messages'])(
    'reserves the proxy output default for %s without confusing the Codex wire protocol',
    upstreamApiFormat => {
      const configured = model(
        {
          context_window: 1_048_576,
          protocol: 'openai-responses',
          upstreamApiFormat,
        },
        { runtime: { family: 'openai.openai-responses' } }
      )
      expect(modelMaxOutputTokensFromConfig(configured)).toBeNull()
      expect(modelInputTokenBudget(configured)).toBe(952_576)
      expect(
        modelInputTokenBudget({
          ...configured,
          config: { ...configured.config, max_output_tokens: 8_000 },
        })
      ).toBe(1_040_576)
    }
  )

  test.each(['openai-chat-completions', 'anthropic-messages'])(
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

  test('uses the execution Catalog selection and shared default for cloud models', () => {
    expect(modelInputTokenBudget(model({ protocol: 'openai' }, { modelId: 'kimi-k3.1-pro' }))).toBe(
      952_576
    )
    expect(modelInputTokenBudget(model({ protocol: 'openai' }))).toBe(176_000)
    expect(
      modelInputTokenBudget(model({ protocol: 'openai', codexCatalogModelId: 'unknown-catalog' }))
    ).toBeNull()
  })

  test('keeps native Responses defaults and explicit configuration ahead of the Catalog', () => {
    const configured = model({
      codex_catalog_model_id: 'wework-gpt-6.1-sol',
      protocol: 'openai-responses',
    })
    expect(modelInputTokenBudget(configured)).toBe(272_000)
    expect(applyModelContextWindowOverride(baseUsage, configured)).toBe(baseUsage)
    expect(
      modelInputTokenBudget({ ...configured, contextWindow: 1_000_000, maxOutputTokens: 8_000 })
    ).toBe(992_000)
  })

  test.each(['codex-official', 'codex-provider'])(
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

  test('keeps the full context window when no output budget is reserved', () => {
    expect(modelInputTokenBudget(model({ context_window: 1_000_000 }))).toBe(1_000_000)
    expect(
      modelInputTokenBudget(model({ context_window: 1_000_000, max_output_tokens: 1_000_000 }))
    ).toBe(1_000_000)
    expect(
      modelInputTokenBudget(model({ max_output_tokens: 384_000 }, { type: 'runtime' }))
    ).toBeNull()
    expect(modelInputTokenBudget(null)).toBeNull()
  })

  test('measures reported usage against the reserved input token budget', () => {
    expect(
      applyModelContextWindowOverride(
        { ...baseUsage, modelContextWindow: 996_147 },
        model({ context_window: 1_000_000, max_output_tokens: 384_000 })
      ).modelContextWindow
    ).toBe(616_000)
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
