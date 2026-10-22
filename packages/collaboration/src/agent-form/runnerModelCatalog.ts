import type { UnifiedModel } from '@wegent/chat-core/models'
import { localCodexModelSource } from '@wegent/chat-core/runtime-model-catalog'
import { runnerModelKey, type RunnerModel } from './runnerRouting'

/** Adapt execution identities to the shared picker without losing catalog metadata. */
export function runnerModelToUnifiedModel(
  model: RunnerModel,
  cloudCatalog: UnifiedModel[]
): UnifiedModel {
  if (model.source === 'cloud') {
    const ref = model.cloud_model
    const catalogModel = cloudCatalog.find(
      item =>
        item.name === ref?.name &&
        item.type === ref?.type &&
        item.namespace === ref?.namespace &&
        item.resourceUserId === ref?.resource_user_id
    )
    if (!catalogModel) throw new Error('Cloud model is missing from its catalog')
    return { ...catalogModel, name: runnerModelKey(model) }
  }
  const source =
    model.runtime === 'codex'
      ? localCodexModelSource({
          providerId: model.provider,
          providerName: model.account_label,
          providerType: model.provider === 'openai' ? 'official' : 'provider',
        })
      : { provider: 'local' }
  return {
    ...source,
    name: runnerModelKey(model),
    type: 'runtime',
    displayName: model.label,
    modelId: model.model_id,
    runtime: { family: model.runtime },
  }
}
