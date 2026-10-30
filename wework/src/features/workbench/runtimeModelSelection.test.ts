import { describe, expect, test } from 'vitest'
import { defaultNewChatModelSelection, selectedModelExecutionFields } from './runtimeModelSelection'
import type { UnifiedModel } from '@/types/api'

describe('runtimeModelSelection', () => {
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

  test('sends default collaboration mode when plan mode is not selected', () => {
    expect(selectedModelExecutionFields(null, {})).toEqual({
      modelOptions: { collaborationMode: 'default' },
    })
  })

  test('keeps model options when the default model is selected', () => {
    expect(selectedModelExecutionFields(null, { collaborationMode: 'plan' })).toEqual({
      modelOptions: { collaborationMode: 'plan' },
    })
  })

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

  test('uses the cloud model marked as the picker default', () => {
    const firstCloudModel: UnifiedModel = {
      name: 'cloud-first',
      type: 'public',
      provider: 'cloud',
      config: { ui: { family: 'gpt' } },
    }
    const defaultCloudModel: UnifiedModel = {
      name: 'cloud-default',
      type: 'public',
      provider: 'cloud',
      config: {
        ui: {
          family: 'gpt',
          defaultModel: true,
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
        },
      },
    }

    expect(defaultNewChatModelSelection([firstCloudModel, defaultCloudModel])).toMatchObject({
      modelName: 'cloud-default',
      modelType: 'public',
      options: {
        reasoning: 'high',
      },
    })
  })

  test('passes Codex provider id as hidden execution options', () => {
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

    expect(
      selectedModelExecutionFields(providerModel, { speed: 'fast', reasoning: 'extra_high' })
    ).toEqual({
      modelId: 'Doubao-Seed-2.0-pro-260215',
      modelType: 'runtime',
      modelOptions: {
        speed: 'fast',
        reasoning: 'xhigh',
        collaborationMode: 'default',
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
        codexProviderType: 'provider',
      },
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
        weworkCloudModelNativeToolSearch: 'true',
        weworkCloudModelNativeNamespaceTools: 'true',
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
  ])('enables native Codex tools by default for Responses cloud model %s', (modelId, catalogId) => {
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
        weworkCloudModelNativeToolSearch: 'true',
        weworkCloudModelNativeNamespaceTools: 'true',
        ...(catalogId ? { weworkCloudModelCodexCatalogModelId: catalogId } : {}),
      },
    })
  })

  test.each([
    {
      override: { native_tool_search: false },
      disabledOption: 'weworkCloudModelNativeToolSearch',
      inferredOption: 'weworkCloudModelNativeNamespaceTools',
    },
    {
      override: { nativeNamespaceTools: false },
      disabledOption: 'weworkCloudModelNativeNamespaceTools',
      inferredOption: 'weworkCloudModelNativeToolSearch',
    },
  ])(
    'honors an explicit false override for $disabledOption independently',
    ({ override, disabledOption, inferredOption }) => {
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

      expect(modelOptions).toHaveProperty(disabledOption, 'false')
      expect(modelOptions).toHaveProperty(inferredOption, 'true')
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
        weworkCloudModelNativeToolSearch: 'true',
        weworkCloudModelNativeNamespaceTools: 'true',
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
