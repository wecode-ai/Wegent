import { beforeEach, describe, expect, test } from 'vitest'
import { groupLegacyModels, resolveProviderModel } from './providerModelConfiguration'
import { getProviderModelConfigs, replaceProviderModelConfigs } from './providerModelState'
import {
  findLocalModelConfigByModelName,
  localModelConfigRequestUrl,
  listLocalModelConfigs,
  localModelName,
  markLocalModelCatalogReady,
  saveLocalModelConfig,
} from './localModelSettings'

beforeEach(() => {
  localStorage.clear()
  replaceProviderModelConfigs([])
})
const provider = {
  id: 'relay',
  name: 'Relay',
  base_url: 'https://relay.example/v1',
  api_format: 'openai-responses' as const,
  api_key: 'test-key',
}

describe('Provider configuration runtime adapter', () => {
  test('keeps existing local-model identity and never enters the Codex-provider namespace', () => {
    const model = resolveProviderModel({
      provider,
      model: { id: 'stable-id', model_id: 'shared-upstream-id' },
    })
    replaceProviderModelConfigs([model])
    expect(localModelName(model)).toBe('local-model:stable-id')
    expect(findLocalModelConfigByModelName('local-model:stable-id')).toBe(model)
    expect(findLocalModelConfigByModelName('cloud-model')).toBeNull()
    expect(localStorage.length).toBe(0)
  })
  test('new catalog entries are pending until reconciliation, then unchanged reloads stay ready', () => {
    const entry = { provider, model: { id: 'stable-id', model_id: 'model-a' } }
    const model = resolveProviderModel(entry)
    expect(model.catalogReady).toBe(false)
    replaceProviderModelConfigs([model])
    markLocalModelCatalogReady([model])
    const current = getProviderModelConfigs()[0]
    expect(current.catalogReady).toBe(true)
    expect(resolveProviderModel(entry, current)).toBe(current)
  })
  test('changing credentials preserves catalog readiness but invalidates runtime identity version', () => {
    const entry = { provider, model: { id: 'stable-id', model_id: 'model-a' } }
    const before = { ...resolveProviderModel(entry), catalogReady: true }
    const after = resolveProviderModel(
      { ...entry, provider: { ...provider, api_key: 'new-key' } },
      before
    )
    expect(after.catalogReady).toBe(true)
    expect(after.updatedAt).not.toBe(before.updatedAt)
    expect(after.id).toBe(before.id)
  })
  test('protocol overrides inherit the key but not an incompatible request path', () => {
    const model = resolveProviderModel({
      provider: { ...provider, request_path: '/responses' },
      model: { id: 'm', model_id: 'upstream', api_format: 'anthropic-messages' },
    })
    expect(model.requestPath).toBe('/messages')
    expect(model.toolProfile).toBe('function')
    expect(model.apiKey).toBe(provider.api_key)
  })
  test('migration groups only identical connections and preserves capabilities and IDs', () => {
    const first = saveLocalModelConfig({
      id: 'legacy-a',
      modelId: 'a',
      baseUrl: provider.base_url,
      apiKey: 'key-a',
      contextWindow: 12345,
    })
    const second = saveLocalModelConfig({
      id: 'legacy-b',
      modelId: 'b',
      baseUrl: provider.base_url,
      apiKey: 'key-a',
    })
    const third = saveLocalModelConfig({
      id: 'legacy-c',
      modelId: 'a',
      baseUrl: provider.base_url,
      apiKey: 'different-key',
    })
    const groups = groupLegacyModels([first, second, third])
    expect(groups).toHaveLength(2)
    expect(groups[0].models.map(model => model.id)).toEqual(['legacy-a', 'legacy-b'])
    expect(groups[0].models[0].catalog_entry).toEqual(first.catalogEntry)
    expect(groups[0].models[0].context_window).toBe(12345)
  })
  test('projection shadows only matching migrated IDs; legacy records and cloud-looking names remain distinct', () => {
    const legacy = saveLocalModelConfig({
      id: 'old',
      modelId: 'shared',
      baseUrl: provider.base_url,
    })
    saveLocalModelConfig({ id: 'independent', modelId: 'shared', baseUrl: provider.base_url })
    const migrated = resolveProviderModel({
      provider,
      model: { id: legacy.id, model_id: legacy.modelId },
    })
    replaceProviderModelConfigs([migrated])
    expect(listLocalModelConfigs()).toHaveLength(2)
    expect(listLocalModelConfigs().find(model => model.id === 'old')).toBe(migrated)
    expect(() =>
      saveLocalModelConfig({ id: 'old', modelId: 'changed', baseUrl: provider.base_url })
    ).toThrow(/Provider settings/)
  })
})

describe('Provider request URL resolution', () => {
  test('preserves complete gateway prefixes instead of treating the last segment as an endpoint', () => {
    const resolved = resolveProviderModel({
      provider: { ...provider, base_url: 'https://relay.example/api/coding/v3' },
      model: { id: 'm', model_id: 'model-a' },
    })
    expect(localModelConfigRequestUrl(resolved)).toBe(
      'https://relay.example/api/coding/v3/responses'
    )
  })
  test('preserves explicit path overrides without duplicating or dropping prefix segments', () => {
    const resolved = resolveProviderModel({
      provider: { ...provider, base_url: 'https://relay.example/custom' },
      model: {
        id: 'm',
        model_id: 'model-a',
        api_format: 'openai-chat-completions',
        request_path: '/inference/chat/completions',
      },
    })
    expect(localModelConfigRequestUrl(resolved)).toBe(
      'https://relay.example/custom/inference/chat/completions'
    )
  })
  test('retains legacy full endpoint normalization for existing configurations', () => {
    const legacy = saveLocalModelConfig({
      modelId: 'a',
      baseUrl: 'https://relay.example/v1/responses',
    })
    expect(localModelConfigRequestUrl(legacy)).toBe('https://relay.example/v1/responses')
  })
})
