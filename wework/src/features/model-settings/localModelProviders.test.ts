import { describe, expect, it, vi } from 'vitest'
import type { LocalModelConfig } from './localModelSettings'
import {
  discoverProviderModels,
  findLocalModelProviderProfile,
  localModelSupportsImageInput,
} from './localModelProviders'

function localModelConfig(overrides: Partial<LocalModelConfig>): LocalModelConfig {
  return {
    id: 'model-id',
    displayName: 'Model',
    modelId: 'model',
    baseUrl: 'https://example.com/v1',
    apiFormat: 'openai-chat-completions',
    toolProfile: 'function',
    webSearchMode: 'disabled',
    imageGenerationEnabled: false,
    catalogReady: true,
    enabled: true,
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('localModelProviders', () => {
  it('defines the Kimi Coding profile with only provider-managed defaults', () => {
    const profile = findLocalModelProviderProfile('kimi-coding')

    expect(profile).toMatchObject({
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiFormat: 'openai-chat-completions',
      requestPath: '/chat/completions',
      modelsPath: '/models',
      toolProfile: 'function',
      contextWindow: 262_144,
      modelDefaults: {
        k3: {
          contextWindow: 262_144,
          codexCatalogModelId: 'wework-kimi-k3',
        },
        'kimi-for-coding': {
          contextWindow: 262_144,
          codexCatalogModelId: 'wework-kimi-k2-7',
        },
      },
    })
  })

  it.each([
    [
      'kimi',
      {
        baseUrl: 'https://api.moonshot.cn/v1',
        group: 'Kimi',
        apiFormat: 'openai-chat-completions',
        requestPath: '/chat/completions',
        toolProfile: 'function',
        webSearchMode: 'disabled',
        contextWindow: 1_000_000,
        modelDefaults: {
          'kimi-k3': {
            contextWindow: 1_048_576,
            codexCatalogModelId: 'wework-kimi-k3',
          },
          'kimi-k2.6': { contextWindow: 262_144 },
          'moonshot-v1-8k': { contextWindow: 8_192 },
          'moonshot-v1-32k': { contextWindow: 32_768 },
          'moonshot-v1-128k': { contextWindow: 131_072 },
        },
      },
    ],
    [
      'deepseek',
      {
        baseUrl: 'https://api.deepseek.com',
        group: 'DeepSeek',
        apiFormat: 'openai-responses',
        requestPath: '/responses',
        toolProfile: 'custom',
        allowedModelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        contextWindow: 1_048_576,
        webSearchMode: 'live',
        modelDefaults: {
          'deepseek-v4-flash': {
            contextWindow: 1_048_576,
            codexCatalogModelId: 'wework-deepseek-v4-flash',
          },
          'deepseek-v4-pro': {
            contextWindow: 1_048_576,
            codexCatalogModelId: 'wework-deepseek-v4-pro',
          },
        },
      },
    ],
    [
      'glm',
      {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        group: 'GLM',
        apiFormat: 'openai-chat-completions',
        requestPath: '/chat/completions',
        toolProfile: 'function',
        webSearchMode: 'disabled',
        contextWindow: 200_000,
        modelDefaults: { 'glm-5.2': { contextWindow: 1_000_000 } },
      },
    ],
    [
      'minimax',
      {
        displayName: 'MiniMax (China mainland)',
        displayNameKey: 'workbench.local_model_provider_minimax_cn',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        group: 'MiniMax',
        apiFormat: 'anthropic-messages',
        requestPath: '/v1/messages',
        modelsPath: '/v1/models',
        modelsApiKeyHeader: 'X-Api-Key',
        toolProfile: 'function',
        webSearchMode: 'disabled',
        contextWindow: 204_800,
        modelDefaults: {
          'MiniMax-M2.7': { contextWindow: 204_800 },
          'MiniMax-M2.7-highspeed': { contextWindow: 204_800 },
          'MiniMax-M2.5': { contextWindow: 204_800 },
          'MiniMax-M2.5-highspeed': { contextWindow: 204_800 },
          'MiniMax-M2.1': { contextWindow: 204_800 },
          'MiniMax-M2.1-highspeed': { contextWindow: 204_800 },
          'MiniMax-M2': { contextWindow: 204_800 },
        },
      },
    ],
    [
      'minimax-global',
      {
        displayName: 'MiniMax (Global)',
        displayNameKey: 'workbench.local_model_provider_minimax_global',
        baseUrl: 'https://api.minimax.io/anthropic',
        group: 'MiniMax',
        apiFormat: 'anthropic-messages',
        requestPath: '/v1/messages',
        modelsPath: '/v1/models',
        modelsApiKeyHeader: 'X-Api-Key',
        toolProfile: 'function',
        webSearchMode: 'disabled',
        contextWindow: 204_800,
        modelDefaults: {
          'MiniMax-M2.7': { contextWindow: 204_800 },
          'MiniMax-M2.7-highspeed': { contextWindow: 204_800 },
          'MiniMax-M2.5': { contextWindow: 204_800 },
          'MiniMax-M2.5-highspeed': { contextWindow: 204_800 },
          'MiniMax-M2.1': { contextWindow: 204_800 },
          'MiniMax-M2.1-highspeed': { contextWindow: 204_800 },
          'MiniMax-M2': { contextWindow: 204_800 },
        },
      },
    ],
  ] as const)('defines the %s official provider profile', (profileId, expected) => {
    expect(findLocalModelProviderProfile(profileId)).toMatchObject({
      ...expected,
      modelsPath: 'modelsPath' in expected ? expected.modelsPath : '/models',
      imageGenerationEnabled: false,
    })
  })

  it.each([
    ['minimax', 'https://api.minimaxi.com/anthropic/v1/models'],
    ['minimax-global', 'https://api.minimax.io/anthropic/v1/models'],
  ] as const)(
    'uses the MiniMax API key header when discovering models for %s',
    async (profileId, modelsUrl) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'MiniMax-M2.7' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      await expect(
        discoverProviderModels(findLocalModelProviderProfile(profileId), 'secret-key', { fetcher })
      ).resolves.toEqual([{ id: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' }])

      expect(fetcher).toHaveBeenCalledWith(
        modelsUrl,
        expect.objectContaining({
          method: 'GET',
          headers: { 'X-Api-Key': 'secret-key' },
        })
      )
    }
  )

  it('only exposes models supported by the DeepSeek Codex integration', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    await expect(
      discoverProviderModels(findLocalModelProviderProfile('deepseek'), 'secret-key', { fetcher })
    ).resolves.toEqual([
      { id: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro' },
    ])
  })

  it('recognizes a Kimi Coding K3 model saved with a stale provider profile', () => {
    expect(
      localModelSupportsImageInput(
        localModelConfig({
          providerProfileId: 'kimi',
          modelId: 'k3',
          baseUrl: 'https://api.kimi.com/coding/v1/',
          catalogEntry: {
            slug: 'legacy-k3',
            display_name: 'K3',
            input_modalities: ['text'],
          },
        })
      )
    ).toBe(true)
  })

  it('does not infer image support from a matching model id on an unknown endpoint', () => {
    expect(
      localModelSupportsImageInput(
        localModelConfig({
          providerProfileId: 'custom',
          modelId: 'k3',
          baseUrl: 'https://example.com/v1',
          catalogEntry: {
            slug: 'custom-k3',
            display_name: 'Custom K3',
            input_modalities: ['text'],
          },
        })
      )
    ).toBe(false)
  })

  it('loads, validates, sorts, and deduplicates provider model entries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'k3' }, { id: '' }, { id: 'kimi-for-coding' }, { id: 'k3' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const models = await discoverProviderModels(
      findLocalModelProviderProfile('kimi-coding'),
      'secret-key',
      { fetcher }
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer secret-key' },
      })
    )
    expect(models).toEqual([
      { id: 'k3', displayName: 'k3' },
      { id: 'kimi-for-coding', displayName: 'kimi-for-coding' },
    ])
  })

  it('reports provider HTTP errors instead of accepting an invalid catalog', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid token' } }), { status: 401 })
      )

    await expect(
      discoverProviderModels(findLocalModelProviderProfile('kimi-coding'), 'bad-key', { fetcher })
    ).rejects.toThrow('HTTP 401: invalid token')
  })
})
