import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getProviderConfigurationState,
  reloadProviderConfiguration,
  saveProviderConfiguration,
  type ModelProvider,
} from './providerModelConfiguration'
import {
  listLegacyLocalModelConfigs,
  listLocalModelConfigs,
  saveLocalModelConfig,
} from './localModelSettings'
import { replaceProviderModelConfigs } from './providerModelState'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invoke,
  subscribeDesktopHostEvents: vi.fn(),
}))
let providers: ModelProvider[]
let revision: string
let failSave: boolean
let mismatch: boolean
beforeEach(() => {
  localStorage.clear()
  replaceProviderModelConfigs([])
  providers = []
  revision = 'first'
  failSave = false
  mismatch = false
  invoke.mockReset()
  invoke.mockImplementation(async (method, args) => {
    if (method === 'modelConfiguration.read')
      return { path: '/test/models.yml', revision, providers, loadedAt: '' }
    if (method === 'modelConfiguration.save') {
      if (failSave) throw new Error('Write failed')
      providers = args.providers
      revision = 'saved'
      return { revision, providers }
    }
    if (method === 'modelConfiguration.runtime')
      return {
        revision: mismatch ? 'stale' : revision,
        models: providers.flatMap(provider => provider.models.map(model => ({ provider, model }))),
      }
    throw new Error(`Unexpected method: ${method}`)
  })
})

describe('Automatic legacy model migration', () => {
  test('save waits for a superseding native refresh to publish the deleted model', async () => {
    providers = [
      {
        id: 'relay',
        name: 'Relay',
        base_url: 'https://relay.example',
        api_format: 'openai-responses',
        models: [{ id: 'old', model_id: 'old' }],
      },
    ]
    await reloadProviderConfiguration()
    const original = invoke.getMockImplementation()!
    let releaseSaveRefresh!: () => void
    let releaseNativeRefresh!: () => void
    const saveRefresh = new Promise<void>(resolve => {
      releaseSaveRefresh = resolve
    })
    const nativeRefresh = new Promise<void>(resolve => {
      releaseNativeRefresh = resolve
    })
    let reads = 0
    invoke.mockImplementation(async (method, args) => {
      if (method === 'modelConfiguration.read') {
        reads += 1
        await (reads === 1 ? saveRefresh : nativeRefresh)
      }
      return original(method, args)
    })
    let finished = false
    const save = saveProviderConfiguration(revision, []).then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    const notification = reloadProviderConfiguration()
    releaseSaveRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(finished).toBe(false)
    expect(getProviderConfigurationState().snapshot?.providers).toHaveLength(1)
    releaseNativeRefresh()
    await Promise.all([save, notification])
    expect(getProviderConfigurationState().snapshot?.providers).toEqual([])
    expect(listLocalModelConfigs()).toEqual([])
  })

  test('concurrent catalog refreshes share the migration write', async () => {
    saveLocalModelConfig({ id: 'old-a', modelId: 'a', baseUrl: 'https://relay.example/v1' })
    const original = invoke.getMockImplementation()!
    let finish!: () => void
    const held = new Promise<void>(resolve => {
      finish = resolve
    })
    invoke.mockImplementation(async (method, args) => {
      if (method === 'modelConfiguration.save') await held
      return original(method, args)
    })
    const first = reloadProviderConfiguration()
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([method]) => method === 'modelConfiguration.save')).toBe(true)
    )
    const second = reloadProviderConfiguration()
    await new Promise(resolve => setTimeout(resolve, 0))
    finish()
    await Promise.all([first, second])
    expect(
      invoke.mock.calls.filter(([method]) => method === 'modelConfiguration.save')
    ).toHaveLength(1)
    expect(listLegacyLocalModelConfigs()).toEqual([])
  })

  test('preserves IDs, credentials and all capabilities and writes only once', async () => {
    const first = saveLocalModelConfig({
      id: 'old-a',
      modelId: 'a',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      contextWindow: 128000,
      webSearchMode: 'cached',
      imageGenerationEnabled: true,
    })
    saveLocalModelConfig({
      id: 'old-b',
      modelId: 'b',
      baseUrl: first.baseUrl,
      apiKey: first.apiKey,
    })
    await reloadProviderConfiguration()
    expect(providers).toHaveLength(1)
    expect(providers[0].models.map(model => model.id)).toEqual(['old-a', 'old-b'])
    expect(providers[0].models[0]).toEqual(
      expect.objectContaining({
        context_window: 128000,
        web_search_mode: 'cached',
        image_generation_enabled: true,
        catalog_entry: first.catalogEntry,
      })
    )
    expect(providers[0].api_key).toBe('test-key')
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(listLocalModelConfigs().map(model => model.id)).toEqual(['old-a', 'old-b'])
    await reloadProviderConfiguration()
    expect(
      invoke.mock.calls.filter(([method]) => method === 'modelConfiguration.save')
    ).toHaveLength(1)
  })

  test('retains legacy data on a failed write and migrates after recovery', async () => {
    saveLocalModelConfig({ id: 'old-a', modelId: 'a', baseUrl: 'https://relay.example/v1' })
    failSave = true
    await reloadProviderConfiguration()
    expect(getProviderConfigurationState().error).toBe('Write failed')
    expect(listLegacyLocalModelConfigs()).toHaveLength(1)
    failSave = false
    await reloadProviderConfiguration()
    expect(getProviderConfigurationState().error).toBeNull()
    expect(listLegacyLocalModelConfigs()).toEqual([])
  })

  test('retains legacy data until the saved revision is readable by the runtime', async () => {
    saveLocalModelConfig({ id: 'old-a', modelId: 'a', baseUrl: 'https://relay.example/v1' })
    mismatch = true
    await reloadProviderConfiguration()
    expect(getProviderConfigurationState().error).toContain('changed while loading')
    expect(listLegacyLocalModelConfigs()).toHaveLength(1)
    mismatch = false
    await reloadProviderConfiguration()
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(providers).toHaveLength(1)
    expect(
      invoke.mock.calls.filter(([method]) => method === 'modelConfiguration.save')
    ).toHaveLength(1)
  })
})
