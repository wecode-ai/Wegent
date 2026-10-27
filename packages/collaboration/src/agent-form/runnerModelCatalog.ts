import type { UnifiedModel } from '@wegent/chat-core/models'
import { localCodexModelSource } from '@wegent/chat-core/runtime-model-catalog'
import {
  cloudRunnerModelIdentity,
  runnerModelIdentity,
  type RunnerModel,
  type RunnerModelIdentity,
} from './runnerRouting'

export interface RunnerModelCatalogEntry {
  model: UnifiedModel
  identity: RunnerModelIdentity
  isDefault: boolean
}

/** Native catalog DTOs enter the common display catalog once; cloud models stay unchanged. */
export function runnerModelCatalog(
  nativeModels: RunnerModel[],
  cloudModels: UnifiedModel[],
  runtime: RunnerModelIdentity['runtime']
): RunnerModelCatalogEntry[] {
  const entries: RunnerModelCatalogEntry[] = nativeModels
    .filter(model => model.runtime === runtime)
    .map(nativeModel => {
      const source =
        runtime === 'codex'
          ? localCodexModelSource({
              providerId: nativeModel.provider,
              providerName: nativeModel.account_label,
              providerType: nativeModel.provider === 'openai' ? 'official' : 'provider',
            })
          : { provider: 'local' }
      return {
        model: {
          ...source,
          name: nativeModel.model_id,
          type: 'runtime',
          displayName: nativeModel.label,
          modelId: nativeModel.model_id,
          runtime: { family: runtime, provider: nativeModel.provider },
        },
        identity: runnerModelIdentity(nativeModel),
        isDefault: nativeModel.is_default,
      }
    })
  for (const model of cloudModels) {
    const identity = cloudRunnerModelIdentity(model, runtime)
    if (identity) entries.push({ model, identity, isDefault: false })
  }
  return entries
}
