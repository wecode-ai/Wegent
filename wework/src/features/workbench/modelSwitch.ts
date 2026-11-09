import { CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME } from '@/features/model-settings/codexOfficialModels'
import type { UnifiedModel } from '@/types/api'

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

export function requiresNewSessionForModelSwitch(
  activeModel: UnifiedModel | null | undefined,
  targetModel: UnifiedModel | null
): boolean {
  const activeProvider = codexConversationProvider(activeModel)
  const targetProvider = codexConversationProvider(targetModel)
  return Boolean(activeProvider && targetProvider && activeProvider !== targetProvider)
}

export type ModelSwitchContinuation = 'same-session' | 'new-conversation' | 'new-session'
