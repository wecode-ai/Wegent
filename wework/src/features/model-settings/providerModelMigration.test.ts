import {
  listLegacyLocalModelConfigs,
  seedLegacyLocalModelConfig as saveLocalModelConfig,
} from '@/test/model-config-fixtures'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getProviderConfigurationState,
  reloadProviderConfiguration,
  saveProviderConfiguration,
  type ModelProvider,
} from './providerModelConfiguration'
import { listLocalModelConfigs } from './localModelSettings'
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

describe('Native credential authority', () => {
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

  test('never imports restored plaintext renderer records into the native configuration', async () => {
    saveLocalModelConfig({
      id: 'restored',
      modelId: 'a',
      baseUrl: 'https://attacker.example/v1',
      apiKey: 'old-secret-canary',
    })
    providers = [
      {
        id: 'native',
        name: 'Native',
        base_url: 'https://approved.example/v1',
        api_format: 'openai-responses',
        api_key: 'wework-vault.opaque-reference',
        models: [{ id: 'approved', model_id: 'a' }],
      },
    ]
    await Promise.all([reloadProviderConfiguration(), reloadProviderConfiguration()])
    expect(invoke.mock.calls.some(([method]) => method === 'modelConfiguration.save')).toBe(false)
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('old-secret-canary')
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(listLocalModelConfigs().map(model => model.id)).toEqual(['approved'])
    expect(listLocalModelConfigs()[0].apiKey).toBe('wework-vault.opaque-reference')
  })

  test('does not acknowledge an inconsistent runtime revision or discard recovery input', async () => {
    saveLocalModelConfig({ id: 'old-a', modelId: 'a', baseUrl: 'https://relay.example/v1' })
    mismatch = true
    await reloadProviderConfiguration()
    expect(getProviderConfigurationState().error).toContain('changed while loading')
    expect(listLegacyLocalModelConfigs()).toHaveLength(1)
    mismatch = false
    await reloadProviderConfiguration()
    expect(getProviderConfigurationState().error).toBeNull()
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(invoke.mock.calls.some(([method]) => method === 'modelConfiguration.save')).toBe(false)
  })

  test('failed native mutations retain the last visible snapshot and report an error', async () => {
    await reloadProviderConfiguration()
    failSave = true
    await expect(saveProviderConfiguration(revision, [])).rejects.toThrow('Write failed')
    expect(getProviderConfigurationState().snapshot?.revision).toBe(revision)
  })
})
