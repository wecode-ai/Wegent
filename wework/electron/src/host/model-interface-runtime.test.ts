import { describe, expect, test } from 'vitest'
import type { ResolvedProviderModel } from './model-configuration-contract.js'
import {
  modelInterfaceRunnerModels,
  modelInterfaceRuntimeConfig,
  modelInterfaceToolProfile,
} from './model-interface-runtime.js'

const entry: ResolvedProviderModel = {
  provider: {
    id: 'company',
    name: 'Company',
    base_url: 'https://model.example/coding',
    api_format: 'anthropic-messages',
    api_key: 'test-secret',
    request_path: '/v1/messages',
  },
  model: {
    id: 'assistant',
    model_id: 'upstream-model',
    display_name: 'Assistant',
    tool_profile: 'function',
    context_window: 262144,
    max_output_tokens: 16384,
  },
}

describe('device-owned model interfaces', () => {
  test('defaults an arbitrary Responses endpoint to ordinary function tools in both runtime paths', () => {
    const config = {
      id: 'saved-model',
      modelId: 'arbitrary-model',
      displayName: 'Custom API',
      apiFormat: 'openai-responses',
      baseUrl: 'https://private.example/v1',
    }
    const foreground = modelInterfaceRuntimeConfig(config)
    const [background] = modelInterfaceRunnerModels([
      {
        provider: { ...entry.provider, base_url: config.baseUrl, api_format: 'openai-responses' },
        model: { id: config.id, model_id: config.modelId },
      },
    ])
    for (const resolved of [foreground, background.modelConfig]) {
      expect(resolved).toMatchObject({
        tool_profile: 'function',
        native_tool_search: false,
        native_namespace_tools: false,
      })
    }
  })

  test.each([
    ['custom', 'openai-responses', 'custom', 'custom'],
    ['deepseek', 'openai-responses', 'shell', 'shell'],
    ['deepseek', 'openai-chat-completions', undefined, 'function'],
    ['custom', 'openai-responses', undefined, 'function'],
  ] as const)(
    'preserves %s %s %s tool settings',
    (providerProfileId, apiFormat, toolProfile, expected) => {
      expect(modelInterfaceToolProfile({ providerProfileId, apiFormat, toolProfile })).toBe(
        expected
      )
    }
  )

  test.each(['custom', 'function', undefined] as const)(
    'respects explicit %s tools without a provider-specific override',
    toolProfile => {
      const config = {
        id: 'deepseek',
        providerProfileId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai-responses',
        toolProfile,
      }
      const foreground = modelInterfaceRuntimeConfig(config)
      const [background] = modelInterfaceRunnerModels([
        {
          provider: { ...entry.provider, base_url: config.baseUrl, api_format: 'openai-responses' },
          model: {
            id: config.id,
            model_id: config.modelId,
            provider_profile_id: 'deepseek',
            tool_profile: toolProfile,
          },
        },
      ])
      expect(foreground.tool_profile).toBe(toolProfile ?? 'function')
      expect(background.modelConfig.tool_profile).toBe(toolProfile ?? 'function')
      expect(foreground.upstream_api_format).toBe('openai-responses')
    }
  )

  test('does not change native custom tools for other providers', () => {
    expect(
      modelInterfaceRuntimeConfig({
        id: 'native',
        modelId: 'native',
        displayName: 'Native',
        baseUrl: 'https://example.com',
        apiFormat: 'openai-responses',
        toolProfile: 'custom',
      }).tool_profile
    ).toBe('custom')
  })

  test('materializes the same upstream configuration for ordinary and background work', () => {
    const [runner] = modelInterfaceRunnerModels([entry])
    expect(runner.model_id).toBe('local-model:assistant')
    expect(runner.provider).toBe('local-assistant')
    expect(runner.modelConfig).toEqual(
      modelInterfaceRuntimeConfig({
        id: 'assistant',
        modelId: 'upstream-model',
        displayName: 'Assistant',
        baseUrl: 'https://model.example/coding',
        apiFormat: 'anthropic-messages',
        requestPath: '/v1/messages',
        apiKey: 'test-secret',
        toolProfile: 'function',
        codexCatalogModelId: 'wework-custom-assistant',
        contextWindow: 262144,
        maxOutputTokens: 16384,
      })
    )
    expect(runner.modelConfig).toMatchObject({
      wework_local_model_id: 'local-model:assistant',
      upstream_api_format: 'anthropic-messages',
      responses_url: 'https://model.example/coding/v1/messages',
      native_tool_search: false,
      runtime_config: { codex: { use_user_config: false } },
    })
  })

  test('keeps same-upstream interfaces distinct and removes disabled interfaces', () => {
    const second = { ...entry, model: { ...entry.model, id: 'second' } }
    expect(modelInterfaceRunnerModels([entry, second]).map(model => model.provider)).toEqual([
      'local-assistant',
      'local-second',
    ])
    expect(
      modelInterfaceRunnerModels([{ ...entry, provider: { ...entry.provider, enabled: false } }])
    ).toEqual([])
    expect(
      modelInterfaceRunnerModels([{ ...entry, model: { ...entry.model, enabled: false } }])
    ).toEqual([])
  })

  test('an unavailable vision dependency does not block unrelated model interfaces', () => {
    const broken = {
      ...entry,
      model: { ...entry.model, id: 'broken', vision_model_config_id: 'missing' },
    }
    expect(modelInterfaceRunnerModels([broken, entry]).map(model => model.model_id)).toEqual([
      'local-model:assistant',
    ])
  })

  test('preserves protocol overrides, explicit capability IDs and existing request URLs', () => {
    const [runner] = modelInterfaceRunnerModels([
      {
        ...entry,
        model: {
          ...entry.model,
          api_format: 'openai-responses',
          codex_tool_compatibility: 'standard',
          codex_catalog_model_id: 'custom-capability',
          request_path: '/responses',
        },
      },
    ])
    expect(runner.modelConfig).toMatchObject({
      upstream_api_format: 'openai-responses',
      codex_catalog_model_id: 'custom-capability',
      native_namespace_tools: false,
      responses_url: 'https://model.example/coding/responses',
    })
    expect(
      modelInterfaceRuntimeConfig({
        id: 'old',
        modelId: 'model',
        displayName: 'Old',
        apiFormat: 'openai-responses',
        baseUrl: 'https://model.example/v1/responses',
        requestUrl: 'https://model.example/v1/responses',
      }).responses_url
    ).toBe('https://model.example/v1/responses')
  })
})
