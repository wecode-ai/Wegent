// @vitest-environment node

import type { ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { describe, expect, test } from 'vitest'
import {
  defaultNewChatModelSelection,
  requiresNewConversationForModelSwitch,
  selectedModelExecutionFields,
} from './runtimeModelSelection'

describe('runtimeModelSelection', () => {
  test.each<{
    name: string
    source: ModelSelectionConfig
    target: 'official' | 'cloud'
    newSession: boolean
  }>([
    {
      name: 'retired official model',
      source: {
        modelName: 'gpt-5.5',
        modelType: 'runtime',
        options: { codexProviderId: 'openai' },
      },
      target: 'cloud',
      newSession: true,
    },
    {
      name: 'native runner provider metadata',
      source: {
        modelName: 'removed-model',
        modelType: 'runtime',
        options: { runnerModelProvider: 'openai', codexProviderId: 'company' },
      },
      target: 'cloud',
      newSession: true,
    },
    {
      name: 'removed custom provider continuing on the router',
      source: {
        modelName: 'removed-model',
        modelType: 'runtime',
        options: { runnerModelProvider: 'company' },
      },
      target: 'cloud',
      newSession: false,
    },
    {
      name: 'removed cloud model switching to the official provider',
      source: { modelName: 'removed-model', modelType: 'public' },
      target: 'official',
      newSession: true,
    },
    {
      name: 'retired official model continuing on the official provider',
      source: {
        modelName: 'gpt-5.5',
        modelType: 'runtime',
        options: { codexProviderId: 'openai' },
      },
      target: 'official',
      newSession: false,
    },
  ])('uses the saved provider for $name', ({ source, target, newSession }) => {
    const targetModel: UnifiedModel =
      target === 'official'
        ? {
            name: 'gpt-6.1-sol',
            type: 'runtime',
            provider: 'local',
            config: { weworkModelKind: 'codex-official' },
          }
        : { name: 'available-cloud', type: 'public', provider: 'openai' }
    expect(requiresNewConversationForModelSwitch(null, targetModel, source)).toBe(newSession)
    // A replacement with the same name cannot change the persisted session's provider.
    expect(
      requiresNewConversationForModelSwitch(
        {
          name: source.modelName,
          type: 'runtime',
          provider: 'local',
          config: { weworkModelKind: 'codex-provider', codexProviderId: 'replacement' },
        },
        targetModel,
        source
      )
    ).toBe(newSession)
  })

  test.each(['standard', 'passthrough'] as const)(
    'propagates cloud reasoning defaults and %s request mode with selected overrides',
    mode => {
      const model: UnifiedModel = {
        name: 'moonshot-kimi-k3-responses',
        type: 'public',
        namespace: 'default',
        resourceUserId: 0,
        config: {
          protocol: 'openai-responses',
          reasoning: { effort: 'high', summary: 'detailed' },
          codex_request_mode: mode,
          native_tool_search: true,
        },
      }
      const defaults = selectedModelExecutionFields(model, {}).modelOptions
      expect(defaults).toMatchObject({
        reasoning: 'high',
        summary: 'detailed',
        weworkCloudModelCodexRequestMode: mode,
        weworkCloudModelNativeToolSearch: String(mode === 'passthrough'),
        weworkCloudModelNativeNamespaceTools: String(mode === 'passthrough'),
      })
      expect(selectedModelExecutionFields(model, { reasoning: 'low' }).modelOptions).toMatchObject({
        reasoning: 'low',
        summary: 'detailed',
      })
    }
  )

  test('sends the runtime model name instead of its picker label', () => {
    const model: UnifiedModel = {
      name: 'gpt-5.6-sol',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT 5.6 Sol',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'codex-official',
        ui: { family: 'codex-official', modelLabel: 'GPT 5.6 Sol' },
      },
    }

    expect(selectedModelExecutionFields(model, { reasoning: 'medium' })).toMatchObject({
      modelId: 'gpt-5.6-sol',
      modelType: 'runtime',
      modelOptions: { reasoning: 'medium' },
    })
  })

  test('chooses default new chat model by Codex priority', () => {
    const officialWithoutAuth: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'codex-official',
        codexAuthConfigured: false,
        ui: { family: 'codex-official', controls: ['speed'] },
      },
    }
    const officialWithAuth: UnifiedModel = {
      ...officialWithoutAuth,
      config: {
        ...officialWithoutAuth.config,
        codexAuthConfigured: true,
      },
    }
    const officialDefault: UnifiedModel = {
      ...officialWithAuth,
      name: 'gpt-6.1-sol',
      config: {
        ...officialWithAuth.config,
        codexIsDefault: true,
      },
    }
    const providerModel: UnifiedModel = {
      name: 'Doubao-Seed-2.0-pro-260215',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'codex-provider',
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
        codexProviderType: 'provider',
        ui: { family: 'codex-provider', controls: ['speed'] },
      },
    }
    const interfaceModel: UnifiedModel = {
      name: 'local-model:ollama',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'model-interface',
        ui: { family: 'model-interface', controls: ['speed'] },
      },
    }
    const cloudModel: UnifiedModel = {
      name: 'cloud-gpt',
      type: 'public',
      provider: 'cloud',
      config: {
        ui: { family: 'gpt' },
      },
    }

    expect(
      defaultNewChatModelSelection([
        officialWithAuth,
        officialDefault,
        providerModel,
        interfaceModel,
        cloudModel,
      ])
    ).toMatchObject({
      modelName: 'gpt-6.1-sol',
      modelType: 'runtime',
    })
    expect(
      defaultNewChatModelSelection([officialWithoutAuth, providerModel, interfaceModel, cloudModel])
    ).toMatchObject({
      modelName: 'Doubao-Seed-2.0-pro-260215',
      modelType: 'runtime',
      options: {
        codexProviderId: 'wecode-openai',
      },
    })
    expect(
      defaultNewChatModelSelection([officialWithoutAuth, interfaceModel, cloudModel])
    ).toMatchObject({
      modelName: 'local-model:ollama',
      modelType: 'runtime',
    })
    expect(defaultNewChatModelSelection([officialWithoutAuth, cloudModel])).toMatchObject({
      modelName: 'cloud-gpt',
      modelType: 'public',
    })
  })

  test('passes complete cloud model identity as hidden execution options', () => {
    const cloudModel: UnifiedModel = {
      name: 'shared-model',
      type: 'user',
      modelId: 'gpt-5.6-luna',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      contextWindow: 1_048_576,
      maxOutputTokens: 96_000,
      config: {
        context_window: 128000,
        max_output_tokens: 4096,
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelContextWindow: '1048576',
        weworkCloudModelMaxOutputTokens: '96000',
      },
    })
  })

  test('normalizes and passes a configured cloud vision sidecar as a hidden option', () => {
    const cloudModel: UnifiedModel = {
      name: 'primary-cloud-model',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'openai',
      runtime: { family: 'openai.openai-responses' },
      config: {
        visionSidecarModel: {
          modelName: '  cloud-vision  ',
          modelType: 'user',
          namespace: '  default  ',
          resourceUserId: 42,
          apiFormat: 'openai-responses',
        },
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'primary-cloud-model',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
        weworkCloudModelNativeToolSearch: 'false',
        weworkCloudModelNativeNamespaceTools: 'false',
        weworkCloudVisionSidecar:
          '{"modelName":"cloud-vision","modelType":"user","namespace":"default","resourceUserId":42,"apiFormat":"openai-responses"}',
      },
    })
  })

  test.each([
    ['deepseek-v4-flash', 'wework-deepseek-v4-flash'],
    ['deepseek-v4-pro', 'wework-deepseek-v4-pro'],
  ])('selects the %s catalog for a cloud DeepSeek Responses model', (modelId, catalogId) => {
    const cloudModel: UnifiedModel = {
      name: `${modelId}-responses`,
      type: 'public',
      modelId,
      namespace: 'default',
      resourceUserId: 0,
      provider: 'cloud',
      config: { protocol: 'openai-responses' },
    }

    expect(selectedModelExecutionFields(cloudModel, {}).modelOptions).toEqual(
      expect.objectContaining({
        weworkCloudModelCodexCatalogModelId: catalogId,
      })
    )
  })

  test('keeps an unconfigured DeepSeek Responses model text-only', () => {
    const cloudModel: UnifiedModel = {
      name: 'deepseek-v4-pro-responses',
      type: 'public',
      modelId: 'deepseek-v4-pro',
      namespace: 'default',
      resourceUserId: 0,
      provider: 'cloud',
      config: { protocol: 'openai-responses' },
    }

    expect(selectedModelExecutionFields(cloudModel, {}).modelOptions).toEqual(
      expect.not.objectContaining({
        weworkCloudVisionSidecar: expect.anything(),
      })
    )
  })

  test.each(['openai-responses', 'openai-chat-completions', 'anthropic-messages'])(
    'does not infer a catalog for an unregistered model with protocol=%s',
    protocol => {
      const cloudModel: UnifiedModel = {
        name: 'unregistered-model',
        type: 'public',
        modelId: 'different-upstream-model',
        namespace: 'default',
        resourceUserId: 0,
        provider: 'cloud',
        config: { protocol },
      }

      expect(selectedModelExecutionFields(cloudModel, {}).modelOptions).not.toHaveProperty(
        'weworkCloudModelCodexCatalogModelId'
      )
    }
  )

  test.each(['openai-chat-completions', 'anthropic-messages'])(
    'selects the DeepSeek catalog for a cloud model with protocol=%s',
    protocol => {
      const cloudModel: UnifiedModel = {
        name: 'deepseek-v4-pro',
        type: 'public',
        modelId: 'deepseek-v4-pro',
        namespace: 'default',
        resourceUserId: 0,
        provider: 'cloud',
        config: { protocol },
      }

      expect(selectedModelExecutionFields(cloudModel, {}).modelOptions).toEqual(
        expect.objectContaining({
          weworkCloudModelUpstreamApiFormat: protocol,
          weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-pro',
        })
      )
    }
  )

  test.each([
    ['gpt-5.6-sol', null],
    ['gpt-6-astra', 'wework-gpt-6-astra'],
    ['custom-responses-model', null],
  ])('defaults to bridged tools for Responses cloud model %s', (modelId, catalogId) => {
    const cloudModel: UnifiedModel = {
      name: 'shared-gpt-model',
      modelId,
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'openai',
      runtime: { family: 'openai.openai-responses' },
      config: {},
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'shared-gpt-model',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
        weworkCloudModelNativeToolSearch: 'false',
        weworkCloudModelNativeNamespaceTools: 'false',
        ...(catalogId ? { weworkCloudModelCodexCatalogModelId: catalogId } : {}),
      },
    })
  })

  test.each([
    {
      override: { native_tool_search: true },
      enabledOption: 'weworkCloudModelNativeToolSearch',
      inferredOption: 'weworkCloudModelNativeNamespaceTools',
    },
    {
      override: { nativeNamespaceTools: true },
      enabledOption: 'weworkCloudModelNativeNamespaceTools',
      inferredOption: 'weworkCloudModelNativeToolSearch',
    },
  ])(
    'honors an explicit native override for $enabledOption independently',
    ({ override, enabledOption, inferredOption }) => {
      const cloudModel: UnifiedModel = {
        name: 'gpt-5.6-sol',
        type: 'user',
        namespace: 'default',
        resourceUserId: 42,
        provider: 'openai',
        runtime: { family: 'openai.openai-responses' },
        config: override,
      }

      const modelOptions = selectedModelExecutionFields(cloudModel, {}).modelOptions

      expect(modelOptions).toHaveProperty(enabledOption, 'true')
      expect(modelOptions).toHaveProperty(inferredOption, 'false')
    }
  )

  test('does not pass catalog model id as hidden execution option', () => {
    const cloudModel: UnifiedModel = {
      name: 'shared-model',
      type: 'user',
      modelId: 'gpt-5.6-luna',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      config: {
        context_window: 128000,
      },
    }

    expect(
      selectedModelExecutionFields(cloudModel, {
        catalogModelId: 'wework-gpt-5.6-sol',
      })
    ).toEqual({
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        catalogModelId: 'wework-gpt-5.6-sol',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelContextWindow: '128000',
      },
    })
  })

  test('passes upstream api format for OpenAI Chat Completions cloud model', () => {
    const cloudModel: UnifiedModel = {
      name: 'shared-model',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      config: {
        protocol: 'openai',
        apiFormat: 'chat/completions',
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-chat-completions',
      },
    })
  })

  test('selects the Kimi K3 Codex catalog for a cloud responses model', () => {
    const cloudModel: UnifiedModel = {
      name: 'commercial-kimi',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      config: {
        protocol: 'openai-responses',
        base_url: 'https://api.moonshot.cn/v1',
        model_id: 'moonshot-kimi-k3',
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'commercial-kimi',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
        weworkCloudModelNativeToolSearch: 'false',
        weworkCloudModelNativeNamespaceTools: 'false',
        weworkCloudModelCodexCatalogModelId: 'wework-kimi-k3',
      },
    })
  })

  test('selects the Kimi K3 Codex catalog for a cloud chat-completions model', () => {
    const cloudModel: UnifiedModel = {
      name: 'commercial-kimi',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      config: {
        protocol: 'openai',
        apiFormat: 'chat/completions',
        base_url: 'https://api.moonshot.cn/v1',
        model_id: 'moonshot-kimi-k3',
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'commercial-kimi',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-chat-completions',
        weworkCloudModelCodexCatalogModelId: 'wework-kimi-k3',
      },
    })
  })

  test.each(['codex_catalog_model_id', 'codexCatalogModelId'] as const)(
    'preserves the explicit Codex catalog from %s for a Kimi K3 model',
    catalogConfigKey => {
      const cloudModel: UnifiedModel = {
        name: 'commercial-kimi',
        type: 'user',
        namespace: 'default',
        resourceUserId: 42,
        provider: 'cloud',
        config: {
          protocol: 'openai',
          apiFormat: 'chat/completions',
          model_id: 'moonshot-kimi-k3',
          [catalogConfigKey]: 'operator-selected-catalog',
        },
      }

      expect(selectedModelExecutionFields(cloudModel, {}).modelOptions).toEqual(
        expect.objectContaining({
          weworkCloudModelCodexCatalogModelId: 'operator-selected-catalog',
        })
      )
    }
  )

  test('does not select the Kimi K3 catalog for other Moonshot models', () => {
    const cloudModel: UnifiedModel = {
      name: 'commercial-kimi',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      config: {
        protocol: 'openai',
        apiFormat: 'chat/completions',
        base_url: 'https://api.moonshot.cn/v1',
        model_id: 'moonshotai/kimi-k2.5',
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'commercial-kimi',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-chat-completions',
      },
    })
  })

  test('passes upstream api format for Anthropic Messages cloud model', () => {
    const cloudModel: UnifiedModel = {
      name: 'shared-model',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      provider: 'cloud',
      config: {
        protocol: 'claude',
      },
    }

    expect(selectedModelExecutionFields(cloudModel, {})).toEqual({
      modelId: 'shared-model',
      modelType: 'user',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'anthropic-messages',
      },
    })
  })
})
