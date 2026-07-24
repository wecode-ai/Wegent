import { describe, expect, it, vi } from 'vitest'
import { discoverProviderModels, findLocalModelProviderProfile } from './localModelProviders'

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
        contextWindow: 1_000_000,
        modelDefaults: {
          'kimi-k3': { contextWindow: 1_000_000 },
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
        contextWindow: 1_000_000,
        modelDefaults: {
          'deepseek-v4-flash': { contextWindow: 1_000_000 },
          'deepseek-v4-pro': { contextWindow: 1_000_000 },
        },
      },
    ],
    [
      'glm',
      {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        group: 'GLM',
        contextWindow: 200_000,
        modelDefaults: { 'glm-5.2': { contextWindow: 1_000_000 } },
      },
    ],
  ] as const)('defines the %s official provider profile', (profileId, expected) => {
    expect(findLocalModelProviderProfile(profileId)).toMatchObject({
      ...expected,
      apiFormat: 'openai-chat-completions',
      requestPath: '/chat/completions',
      modelsPath: '/models',
      toolProfile: 'function',
      webSearchMode: 'disabled',
      imageGenerationEnabled: false,
    })
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
