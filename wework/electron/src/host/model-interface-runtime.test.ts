import { describe, expect, test } from 'vitest'
import type { ResolvedProviderModel } from './model-configuration-contract.js'
import {
  modelInterfaceRunnerModels,
  modelInterfaceRuntimeConfig,
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
