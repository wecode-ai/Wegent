export * from '@wegent/collaboration/controls/runtimeModelSelection'

import type { ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME } from '@/features/model-settings/codexOfficialModels'

function codexConversationProvider(
  model: UnifiedModel | null | undefined
): 'openai' | 'router' | null {
  if (!model || model.name === CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME) return null
  const configuredKind =
    typeof model.config?.weworkModelKind === 'string'
      ? model.config.weworkModelKind
      : typeof (model.config?.ui as Record<string, unknown> | undefined)?.family === 'string'
        ? ((model.config?.ui as Record<string, unknown>).family as string)
        : ''
  if (configuredKind === 'codex-official') return 'openai'
  if (configuredKind === 'codex-provider' || configuredKind === 'model-interface') return 'router'
  return model.provider && model.provider !== 'local' ? 'router' : null
}

export function savedConversationProvider(
  activeSelection?: ModelSelectionConfig | null
): string | null {
  const savedProviderId =
    activeSelection?.options?.runnerModelProvider ?? activeSelection?.options?.codexProviderId
  return activeSelection?.modelType && activeSelection.modelType !== 'runtime'
    ? 'router'
    : savedProviderId || null
}

export function requiresNewConversationForModelSwitch(
  activeModel: UnifiedModel | null | undefined,
  targetModel: UnifiedModel | null,
  activeSelection?: ModelSelectionConfig | null,
  activeProviderId?: string | null
): boolean {
  // A session's provider identity outlives its selectable catalog entry.
  const providerId = activeProviderId ?? savedConversationProvider(activeSelection)
  const activeProvider = providerId
    ? providerId === 'openai'
      ? 'openai'
      : 'router'
    : codexConversationProvider(activeModel)
  const targetProvider = codexConversationProvider(targetModel)
  return Boolean(activeProvider && targetProvider && activeProvider !== targetProvider)
}
