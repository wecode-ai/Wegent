import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { User } from '@/types/api'

export interface HarnessUserContext {
  id: number
  userName: string
  displayName: string
  email: string
  mode: 'local' | 'cloud'
}

export interface HarnessModelContext {
  runtimeModelId: string
  displayName: string
  modelType: string
  namespace?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities: Record<string, boolean>
}

export interface HarnessContextRegistration {
  token: string
  baseUrl: string
}

export function buildHarnessUserContext(
  user: User,
  mode: HarnessUserContext['mode']
): HarnessUserContext {
  return {
    id: user.id,
    userName: user.user_name,
    displayName: user.user_name,
    email: user.email,
    mode,
  }
}

export function buildHarnessModelContext(option: LocalHarnessModelOption): HarnessModelContext {
  const execution = selectedModelExecutionFields(option.model, option.options)
  const context: HarnessModelContext = {
    runtimeModelId: option.model.modelId?.trim() || execution.modelId || option.model.name,
    displayName: option.label,
    modelType: execution.modelType ?? option.model.type,
    capabilities: {},
  }
  if (option.model.namespace) context.namespace = option.model.namespace
  if (option.model.contextWindow && option.model.contextWindow > 0) {
    context.contextWindow = option.model.contextWindow
  }
  if (option.model.maxOutputTokens && option.model.maxOutputTokens > 0) {
    context.maxOutputTokens = option.model.maxOutputTokens
  }
  return context
}
