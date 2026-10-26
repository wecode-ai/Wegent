import { describe, expect, it } from 'vitest'
import { localCodexModelSource } from '@wegent/chat-core/runtime-model-catalog'
import type { UnifiedModel } from '@wegent/chat-core/models'
import { runnerModelKey, type RunnerModel } from './runnerRouting'
import { runnerModelCatalog } from './runnerModelCatalog'
import {
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  isSameModelSelection,
  modelSelectionKey,
} from '../controls/model-ui'

const native: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'gpt-sol',
  label: 'GPT Sol',
  local_model_id: 'gpt-sol',
  account_label: 'ChatGPT',
  is_default: true,
}

describe('runner model picker catalog', () => {
  it('uses the unchanged common catalog for network labels and ordering', () => {
    const catalog: UnifiedModel[] = ['公网', '内网', '海外'].map(region => ({
      name: `kimi-k3(${region})`,
      type: 'public',
      namespace: 'default',
      resourceUserId: 0,
      displayName: `${region}:Kimi-K3`,
      modelId: 'kimi-k3',
      provider: 'openai',
      config: { protocol: 'openai-responses' },
    }))
    const entries = runnerModelCatalog([], catalog, 'codex')
    const models = entries.map(entry => entry.model)

    models.forEach((model, index) => {
      expect(model).toBe(catalog[index])
      expect(model.config?.ui).toBeUndefined()
      expect(getSelectedModelDisplayLabel(model)).toBe(getSelectedModelDisplayLabel(catalog[index]))
    })
    expect(
      groupModelsByFamily(models)
        .find(group => group.config.id === 'kimi')
        ?.models.map(model => model.displayName)
    ).toEqual(['内网:Kimi-K3', '公网:Kimi-K3', '海外:Kimi-K3'])
  })

  it.each([
    { name: 'kimi-k3(内网)', displayName: 'Kimi-K3', region: 'intranet' },
    { name: 'kimi-k3', displayName: 'Kimi-K3', region: null },
    { name: 'kimi-k3(公网)', displayName: '公网:Kimi-K3', region: 'intranet' },
  ])('does not rewrite network metadata or the catalog name: $name', example => {
    const catalogModel: UnifiedModel = {
      name: example.name,
      displayName: example.displayName,
      type: 'public',
      namespace: 'default',
      resourceUserId: 0,
      modelId: 'kimi-k3',
      config: {
        protocol: 'openai-responses',
        ...(example.name.includes('公网') ? { ui: { region: example.region } } : {}),
      },
    }
    const originalConfig = structuredClone(catalogModel.config)
    const entry = runnerModelCatalog([], [catalogModel], 'codex')[0]
    expect(entry.model).toBe(catalogModel)
    expect(getSelectedModelDisplayLabel(entry.model)).toBe(
      getSelectedModelDisplayLabel(catalogModel)
    )
    expect(catalogModel.config).toEqual(originalConfig)
  })

  it.each(['openai', 'custom'])(
    'adapts native %s metadata once without replacing the model name',
    provider => {
      const model = { ...native, provider }
      const [entry] = runnerModelCatalog([model], [], 'codex')
      expect(entry.model).toMatchObject({
        ...localCodexModelSource({
          providerId: provider,
          providerName: 'ChatGPT',
          providerType: provider === 'openai' ? 'official' : 'provider',
        }),
        name: model.model_id,
      })
      expect(entry.identity).toEqual({
        runtime: model.runtime,
        provider,
        model_id: model.model_id,
      })
      expect(entry.isDefault).toBe(true)
    }
  )

  it('preserves cloud metadata and keeps same-name models from different owners distinct', () => {
    const catalog: UnifiedModel[] = [1, 2].map(resourceUserId => ({
      name: 'sol',
      type: 'user',
      namespace: 'default',
      resourceUserId,
      modelId: 'gpt-sol',
      provider: 'openai',
      config: {
        protocol: 'openai-responses',
        ui: { reasoningEfforts: ['low', 'high'] },
      },
    }))
    const entries = runnerModelCatalog([native], catalog, 'codex')
    expect(entries).toHaveLength(3)
    entries.slice(1).forEach((entry, index) => {
      const model = catalog[index]
      expect(entry.model).toBe(model)
      expect(entry.identity).toEqual({
        runtime: 'codex',
        provider: 'openai',
        model_id: 'gpt-sol',
        source: 'cloud',
        cloud_model: {
          name: model.name,
          type: 'user',
          namespace: model.namespace!,
          resource_user_id: model.resourceUserId!,
        },
      })
    })
    expect(entries[1].model.name).toBe(entries[2].model.name)
    expect(modelSelectionKey(entries[1].model)).not.toBe(modelSelectionKey(entries[2].model))
    expect(runnerModelKey(entries[1].identity)).not.toBe(runnerModelKey(entries[2].identity))
    expect(isSameModelSelection(entries[0].model, entries[1].model)).toBe(false)
  })

  it.each(['codex', 'claude_code'] as const)(
    'keeps same-name %s native accounts distinct',
    runtime => {
      const entries = runnerModelCatalog(
        [
          { ...native, runtime },
          { ...native, runtime, provider: 'custom', account_label: 'Custom' },
        ],
        [],
        runtime
      )
      expect(entries[0].model.name).toBe(entries[1].model.name)
      expect(isSameModelSelection(entries[0].model, entries[1].model)).toBe(false)
      expect(modelSelectionKey(entries[0].model)).not.toBe(modelSelectionKey(entries[1].model))
    }
  )

  it('filters native runtimes and unavailable cloud resources without copying configurations into identities', () => {
    const cloud: UnifiedModel = {
      name: 'cloud-model',
      type: 'public',
      namespace: 'default',
      resourceUserId: 0,
      config: {
        protocol: 'openai-responses',
        api_key: 'must-not-be-persisted',
      },
    }
    const entries = runnerModelCatalog(
      [native, { ...native, runtime: 'claude_code' }],
      [
        cloud,
        { ...cloud, isActive: false },
        { ...cloud, compatibilityDisabled: true },
        { ...cloud, namespace: undefined },
        { ...cloud, resourceUserId: undefined },
        { ...cloud, config: {} },
        { ...cloud, type: 'runtime' },
      ],
      'claude_code'
    )
    expect(entries).toHaveLength(2)
    expect(entries[1].model).toBe(cloud)
    expect(entries.map(entry => entry.identity.runtime)).toEqual(['claude_code', 'claude_code'])
    expect(JSON.stringify(entries.map(entry => entry.identity))).not.toContain(
      'must-not-be-persisted'
    )
  })
})
