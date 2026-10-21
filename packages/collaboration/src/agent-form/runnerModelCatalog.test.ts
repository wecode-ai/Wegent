import { describe, expect, it } from 'vitest'
import { localCodexModelSource } from '@wegent/chat-core/runtime-model-catalog'
import type { UnifiedModel } from '@wegent/chat-core/models'
import { runnerModelKey, type RunnerModel } from './runnerRouting'
import { runnerModelToUnifiedModel } from './runnerModelCatalog'

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
  it.each(['openai', 'custom'])('uses the public Codex source conversion for %s', provider => {
    const model = { ...native, provider }
    expect(runnerModelToUnifiedModel(model, [])).toMatchObject({
      ...localCodexModelSource({
        providerId: provider,
        providerName: 'ChatGPT',
        providerType: provider === 'openai' ? 'official' : 'provider',
      }),
      name: runnerModelKey(model),
    })
  })

  it('preserves cloud metadata and keeps same-name models from different owners distinct', () => {
    const catalog: UnifiedModel[] = [1, 2].map(resourceUserId => ({
      name: 'sol',
      type: 'user',
      namespace: 'default',
      resourceUserId,
      modelId: 'gpt-sol',
      provider: 'openai',
      config: { protocol: 'openai-responses', ui: { reasoningEfforts: ['low', 'high'] } },
    }))
    const converted = catalog.map(model => {
      const runner: RunnerModel = {
        ...native,
        source: 'cloud',
        cloud_model: {
          name: model.name,
          type: 'user',
          namespace: model.namespace!,
          resource_user_id: model.resourceUserId!,
        },
      }
      const result = runnerModelToUnifiedModel(runner, catalog)
      expect(result).toEqual({ ...model, name: runnerModelKey(runner) })
      return result
    })
    expect(converted[0].name).not.toBe(converted[1].name)
    expect(converted[0].name).not.toBe(runnerModelKey(native))
  })
})
