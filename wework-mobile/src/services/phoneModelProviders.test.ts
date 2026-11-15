import * as SecureStore from 'expo-secure-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PhoneModelProviderStore,
  phoneModelRequestUrl,
  phoneLocalRunnerModels,
  type ModelProvider,
} from './phoneModelProviders'
import { modelInterfaceRunnerModels } from '../../../wework/electron/src/host/model-interface-runtime'

const state = vi.hoisted(() => ({ values: new Map<string, string>(), id: 0 }))
vi.mock('expo-crypto', () => ({ randomUUID: () => `provider-${++state.id}` }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => state.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.values.set(key, value)
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    state.values.delete(key)
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
const KEY = 'wework.mobile.model-providers.v1'
const LEGACY = 'wework.mobile.responses-models.v1'
const provider: ModelProvider = {
  id: 'service',
  name: 'Service',
  base_url: 'https://proxy.test/prefix/v1',
  api_format: 'openai-responses',
  api_key: 'private-key',
  models: [
    { id: 'model-a', model_id: 'upstream-a', display_name: 'Model A', tool_profile: 'function' },
  ],
}
async function save(store: PhoneModelProviderStore, input: ModelProvider = provider) {
  return store.saveProvider(input, (await store.providers()).revision)
}

beforeEach(() => {
  state.values.clear()
  state.id = 0
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe('phone provider configuration with PC model semantics', () => {
  it.each([
    ['https://proxy.test/v1', 'https://proxy.test/v1/responses'],
    ['https://proxy.test/prefix/v1/', 'https://proxy.test/prefix/v1/responses'],
    ['http://localhost:8080', 'http://localhost:8080/responses'],
  ])('preserves the provider prefix for %s', (base_url, expected) => {
    expect(phoneModelRequestUrl({ ...provider, base_url })).toBe(expected)
  })
  it.each([
    'file:///tmp/key',
    'https://user:secret@proxy.test/v1',
    'https://proxy.test/v1#key',
    'https://proxy.test/v1?region=cn',
  ])('rejects unsafe addresses %s', async base_url => {
    await expect(save(new PhoneModelProviderStore(), { ...provider, base_url })).rejects.toThrow()
    expect(state.values.has(KEY)).toBe(false)
  })
  it('never reads, rewrites or deletes standalone model configuration', async () => {
    const original =
      '[{"id":"old","baseUrl":"https://proxy.test/v1/responses?region=cn","displayName":"Old","modelId":"old","apiKey":"old-key"}]'
    state.values.set(LEGACY, original)
    const store = new PhoneModelProviderStore()
    expect((await store.providers()).providers).toEqual([])
    await save(store)
    await store.removeProvider('service', (await store.providers()).revision)
    expect(state.values.get(LEGACY)).toBe(original)
    expect(SecureStore.getItemAsync).not.toHaveBeenCalledWith(LEGACY)
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled()
  })
  it('serializes conflicting edits, rejects stale revisions, and never exposes stored secrets', async () => {
    const store = new PhoneModelProviderStore()
    const initial = await store.providers()
    const results = await Promise.allSettled([
      store.saveProvider(provider, initial.revision),
      store.saveProvider({ ...provider, name: 'Other' }, initial.revision),
    ])
    expect(results.map(row => row.status)).toEqual(['fulfilled', 'rejected'])
    const saved = await store.providers()
    expect(JSON.stringify(saved)).not.toContain('private-key')
    const edited = await store.saveProvider(
      { ...saved.providers[0], name: 'Renamed' },
      saved.revision
    )
    expect(edited.providers[0].api_key_configured).toBe(true)
    expect(JSON.parse(state.values.get(KEY)!).providers[0].api_key).toBe('private-key')
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY, expect.any(String), {
      keychainAccessible: 'device-only',
    })
  })
  it('does not publish a failed persistence and recovers without data loss', async () => {
    const store = new PhoneModelProviderStore()
    const saved = await save(store)
    const listener = vi.fn()
    store.subscribe(listener)
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain locked'))
    await expect(
      store.saveProvider({ ...saved.providers[0], name: 'Failed' }, saved.revision)
    ).rejects.toThrow('keychain locked')
    expect(listener).not.toHaveBeenCalled()
    expect(await store.providers()).toEqual(saved)
    await store.saveProvider({ ...saved.providers[0], name: 'Recovered' }, saved.revision)
    expect(listener).toHaveBeenCalledOnce()
  })
  it('uses the exact PC projection for overrides, reasoning, capabilities and vision sidecars', () => {
    const providers: ModelProvider[] = [
      {
        ...provider,
        models: [
          {
            ...provider.models[0],
            api_format: 'anthropic-messages',
            context_window: 128000,
            max_output_tokens: 16000,
            vision_model_config_id: 'vision',
            catalog_entry: { slug: 'custom-a', default_reasoning_level: 'high' },
          },
          { id: 'vision', model_id: 'vision-upstream', tool_profile: 'function' },
        ],
      },
    ]
    const entries = providers.flatMap(provider =>
      provider.models.map(model => ({ provider, model }))
    )
    expect(phoneLocalRunnerModels(providers)).toEqual(modelInterfaceRunnerModels(entries))
    const runner = phoneLocalRunnerModels(providers)[0]
    expect(runner.modelConfig.responses_url).toBe('https://proxy.test/prefix/v1/messages')
    const { modelConfig, ...publicFields } = runner
    expect(JSON.stringify(publicFields)).not.toContain('private-key')
    expect(modelConfig).toMatchObject({ api_key: 'private-key', reasoning: { effort: 'high' } })
  })
  it('hides models from the runtime without deleting their editable configuration', async () => {
    const store = new PhoneModelProviderStore()
    const saved = await save(store)
    const hidden = await store.saveProvider(
      { ...saved.providers[0], models: [{ ...provider.models[0], enabled: false }] },
      saved.revision
    )
    expect((await store.runtimeConfiguration()).models).toEqual([])
    expect(hidden.providers[0].models).toHaveLength(1)
    await store.removeProvider('service', hidden.revision)
    expect((await store.providers()).providers).toEqual([])
  })
  it('discovery uses the saved key, excludes unfinished model rows and preserves overrides', async () => {
    const store = new PhoneModelProviderStore()
    const saved = await save(store)
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'upstream-b' }, { id: 'upstream-a' }, { id: 'upstream-b' }],
        })
      )
    )
    vi.stubGlobal('fetch', fetcher)
    const draft = { ...saved.providers[0], models: [{ id: 'unfinished', model_id: '' }] }
    expect(await store.discover(draft)).toEqual(['upstream-a', 'upstream-b'])
    expect(fetcher).toHaveBeenCalledWith(
      'https://proxy.test/prefix/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer private-key' } })
    )
    expect(await store.providers()).toEqual(saved)
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }))
    await expect(store.discover(draft)).rejects.toThrow('HTTP 403')
    expect(await store.providers()).toEqual(saved)
  })
  it('does not inherit a request path when a model overrides its protocol', () => {
    expect(
      phoneModelRequestUrl(
        { ...provider, request_path: '/responses' },
        { ...provider.models[0], api_format: 'openai-chat-completions' }
      )
    ).toBe('https://proxy.test/prefix/v1/chat/completions')
  })
  it('retains corrupt configuration and refuses to overwrite it', async () => {
    state.values.set(KEY, '{broken')
    const store = new PhoneModelProviderStore()
    await expect(store.providers()).rejects.toThrow()
    await expect(save(store)).rejects.toThrow()
    expect(state.values.get(KEY)).toBe('{broken')
  })
})

it.each([
  [
    'openai-responses',
    '/responses',
    {
      output: [
        { type: 'function_call', name: 'wework_capability_probe', arguments: '{"input":"PING"}' },
      ],
    },
  ],
  [
    'openai-chat-completions',
    '/chat/completions',
    {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'wework_capability_probe', arguments: '{"input":"PING"}' } },
            ],
          },
        },
      ],
    },
  ],
  [
    'anthropic-messages',
    '/messages',
    { content: [{ type: 'tool_use', name: 'wework_capability_probe' }] },
  ],
] as const)(
  'tests one model through the inherited %s connection',
  async (api_format, path, body) => {
    const store = new PhoneModelProviderStore()
    const saved = await save(store)
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      )
    vi.stubGlobal('fetch', fetcher)
    await store.test(
      {
        ...saved.providers[0],
        models: [{ id: 'model-a', model_id: 'upstream-a', api_format, tool_profile: 'function' }],
      },
      'model-a'
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe(`https://proxy.test/prefix/v1${path}`)
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer private-key')
    expect(JSON.parse(fetcher.mock.calls[0][1].body).model).toBe('upstream-a')
    expect(await store.providers()).toEqual(saved)
  }
)
