import * as SecureStore from 'expo-secure-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PhoneLocalModelStore,
  normalizePhoneLocalModel,
  phoneResponsesUrl,
  phoneLocalRunnerModel,
} from './phoneLocalModels'

const state = vi.hoisted(() => ({ raw: null as string | null, id: 0 }))
vi.mock('expo-crypto', () => ({ randomUUID: () => `model-${++state.id}` }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => state.raw),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    state.raw = value
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
const input = {
  displayName: '',
  baseUrl: 'https://proxy.test/prefix/v1',
  modelId: 'model-id',
  apiKey: 'private-key',
}
describe('phone Responses model configuration', () => {
  beforeEach(() => {
    state.raw = null
    state.id = 0
    vi.clearAllMocks()
  })
  it.each([
    ['https://proxy.test/v1', 'https://proxy.test/v1/responses'],
    ['https://proxy.test/prefix/v1/', 'https://proxy.test/prefix/v1/responses'],
    [
      'https://proxy.test/prefix/v1/responses?region=cn',
      'https://proxy.test/prefix/v1/responses?region=cn',
    ],
    ['http://localhost:8080', 'http://localhost:8080/responses'],
  ])('preserves provider prefixes and query at %s', (base, expected) => {
    expect(phoneResponsesUrl(base)).toBe(expected)
  })
  it.each(['file:///tmp/key', 'https://user:secret@proxy.test/v1', 'https://proxy.test/v1#key'])(
    'rejects ambiguous or credential-bearing addresses %s',
    baseUrl => {
      expect(() => normalizePhoneLocalModel({ ...input, baseUrl })).toThrow()
    }
  )
  it('serializes concurrent edits and persists through a new store', async () => {
    const store = new PhoneLocalModelStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const [first, second] = await Promise.all([
      store.save(input),
      store.save({ ...input, modelId: 'second' }),
    ])
    expect(first.displayName).toBe('model-id')
    await store.save({ ...first, displayName: 'Renamed' })
    await store.remove(second.id)
    expect(await new PhoneLocalModelStore().list()).toEqual([{ ...first, displayName: 'Renamed' }])
    expect(listener).toHaveBeenCalledTimes(4)
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      keychainAccessible: 'device-only',
    })
  })
  it('does not publish a failed persistence and can recover without erasing existing models', async () => {
    const store = new PhoneLocalModelStore()
    const first = await store.save(input)
    const listener = vi.fn()
    store.subscribe(listener)
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain locked'))
    await expect(store.save({ ...first, displayName: 'Failed' })).rejects.toThrow('keychain locked')
    expect(listener).not.toHaveBeenCalled()
    expect(await store.list()).toEqual([first])
    await store.save({ ...first, displayName: 'Recovered' })
    expect((await store.list())[0].displayName).toBe('Recovered')
  })
  it('uses the trusted PC runner configuration and replaces both catalogs after deletion', async () => {
    const store = new PhoneLocalModelStore()
    const model = await store.save(input)
    const runner = phoneLocalRunnerModel(model)
    expect(runner).toMatchObject({
      runtime: 'codex',
      provider: `local-${model.id}`,
      model_id: `local-model:${model.id}`,
    })
    const { modelConfig, ...publicFields } = runner
    expect(JSON.stringify(publicFields)).not.toContain('private-key')
    expect(modelConfig).toMatchObject({
      api_key: 'private-key',
      responses_url: 'https://proxy.test/prefix/v1/responses',
    })
    const runtime = { request: vi.fn().mockResolvedValue({}) }
    await store.sync(runtime)
    await store.remove(model.id)
    await store.sync(runtime)
    expect(runtime.request).toHaveBeenLastCalledWith('runtime.models.sync_creation_profiles', {
      profiles: [],
    })
    expect(runtime.request).toHaveBeenNthCalledWith(3, 'runtime.runner.local_models.replace', {
      models: [],
    })
  })
  it('keeps corrupted configuration and rejects edits to deleted models', async () => {
    const store = new PhoneLocalModelStore()
    state.raw = '{broken'
    await expect(store.list()).rejects.toThrow()
    await expect(store.save(input)).rejects.toThrow()
    expect(state.raw).toBe('{broken')
    state.raw = '[]'
    await expect(store.save({ ...input, id: 'deleted' })).rejects.toThrow('已被删除')
  })
})
