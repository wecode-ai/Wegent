import { expect, test } from 'vitest'
import { legacyModelProviders } from './legacy-model-configuration.js'

const legacy = {
  id: 'main',
  modelId: 'upstream',
  displayName: 'Original',
  baseUrl: 'https://relay.example/v1/',
  apiFormat: 'openai-responses',
  requestPath: 'responses/',
  apiKey: 'synthetic-canary',
  enabled: true,
  contextWindow: 128000,
  maxOutputTokens: 16000,
  toolProfile: 'function',
  codexToolCompatibility: 'standard',
  webSearchMode: 'cached',
  imageGenerationEnabled: true,
  visionModelConfigId: 'vision',
  providerProfileId: 'custom',
  codexCatalogModelId: 'catalog',
  catalogEntry: { slug: 'catalog' },
  group: 'Original group',
}

test('preserves model identities, all stored capabilities and connection groups without changing destinations', () => {
  const providers = legacyModelProviders(
    JSON.stringify([
      legacy,
      {
        ...legacy,
        id: 'vision',
        visionModelConfigId: undefined,
        modelId: 'vision-upstream',
        catalogEntry: { slug: 'vision-catalog' },
      },
    ])
  )
  expect(providers).toHaveLength(1)
  expect(providers[0]).toMatchObject({
    base_url: 'https://relay.example/v1',
    request_path: '/responses',
    api_key: 'synthetic-canary',
    api_format: 'openai-responses',
  })
  expect(providers[0].models[0]).toEqual({
    id: 'main',
    model_id: 'upstream',
    display_name: 'Original',
    enabled: true,
    context_window: 128000,
    max_output_tokens: 16000,
    tool_profile: 'function',
    codex_tool_compatibility: 'standard',
    web_search_mode: 'cached',
    image_generation_enabled: true,
    vision_model_config_id: 'vision',
    provider_profile_id: 'custom',
    codex_catalog_model_id: 'catalog',
    catalog_entry: { slug: 'catalog' },
    group: 'Original group',
  })
  expect(providers[0].models.map(model => model.id)).toEqual(['main', 'vision'])
})

test.each([
  ['kimi-coding', 'k3', 'https://api.kimi.com/coding/v1', 262_144, 'wework-kimi-k3'],
  ['kimi', 'kimi-k3', 'https://api.moonshot.cn/v1', 1_048_576, 'wework-kimi-k3'],
  [
    'deepseek',
    'deepseek-v4-flash',
    'https://api.deepseek.com',
    1_048_576,
    'wework-deepseek-v4-flash',
  ],
])(
  'retains the existing %s profile normalization during native import',
  (profile, modelId, baseUrl, context, catalog) => {
    const [provider] = legacyModelProviders(
      JSON.stringify([
        {
          id: 'existing',
          modelId,
          providerProfileId: profile,
          baseUrl,
          apiFormat: 'openai-chat-completions',
          requestPath: '/chat/completions',
          contextWindow: 256000,
        },
      ])
    )
    expect(provider.models[0]).toMatchObject({
      context_window: context,
      codex_catalog_model_id: catalog,
    })
    if (profile === 'deepseek') {
      expect(provider).toMatchObject({ api_format: 'openai-responses', request_path: '/responses' })
      expect(provider.models[0]).toMatchObject({ tool_profile: 'custom', web_search_mode: 'live' })
    }
  }
)

test('retains the international MiniMax profile without changing its destination', () => {
  const [provider] = legacyModelProviders(
    JSON.stringify([
      {
        id: 'existing',
        modelId: 'MiniMax-M2.7',
        providerProfileId: 'minimax',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiFormat: 'anthropic-messages',
      },
    ])
  )
  expect(provider.base_url).toBe('https://api.minimax.io/anthropic')
  expect(provider.models[0].provider_profile_id).toBe('minimax-global')
})

test.each([
  ['https://relay.example/v1/responses', '/responses', 'https://relay.example/v1'],
  ['https://relay.example/api/custom', '/custom', 'https://relay.example/api'],
  ['https://relay.example/v1', '/responses', 'https://relay.example/v1'],
])(
  'normalizes historical complete URLs without changing their request destination: %s',
  (baseUrl, path, base) => {
    const [provider] = legacyModelProviders(
      JSON.stringify([{ id: 'a', modelId: 'a', baseUrl, requestUrlMode: 'custom_url' }])
    )
    expect(provider.base_url).toBe(base)
    expect(provider.request_path).toBe(path)
  }
)

test.each([
  '{}',
  '[null]',
  JSON.stringify([legacy, legacy]),
  JSON.stringify([{ ...legacy, baseUrl: 7 }]),
  JSON.stringify([{ ...legacy, requestPath: 7 }]),
  JSON.stringify([{ ...legacy, baseUrl: 'https://user:password@relay.example' }]),
])('rejects malformed or ambiguous legacy records before publishing: %s', source => {
  expect(() => legacyModelProviders(source)).toThrow()
})
