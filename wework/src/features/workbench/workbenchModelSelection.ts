import type { ModelApi } from '@/api/models'
import { ApiError } from '@/api/http'
import { isSameModelSelection } from '@/lib/model-ui'
import {
  RUNTIME_COMMAND_APPROVAL_OPTION,
  type RuntimeCommandApprovalMode,
} from '@wegent/chat-core/runtime-permission'
import { findModelForSelection } from './runtimeContextUsage'
import {
  CLOUD_MODEL_NAMESPACE_OPTION,
  CLOUD_MODEL_RESOURCE_USER_ID_OPTION,
  modelSelectionIdentityOptions,
} from './runtimeModelSelection'
import {
  modelSelectionIdentityDiagnostics,
  modelSelectionScopeFingerprint,
  type ModelSelectionDiagnostics,
} from './modelSelectionDiagnostics'
import type {
  ModelCompatibilityDisabledReason,
  ModelOptions,
  ModelSelectionConfig,
  UnifiedModel,
} from '@/types/api'

export interface UseWorkbenchModelsOptions {
  api: ModelApi
  locked: boolean
  enabled?: boolean
  filterModel?: (model: UnifiedModel) => boolean
  scopeKey?: string
  persistSelection?: boolean
  selectionConfig?: ModelSelectionConfig | null
  defaultSelectionConfig?: (models: UnifiedModel[]) => ModelSelectionConfig | null
  fallbackWhenConfiguredModelUnavailable?: boolean
  selectionReady?: boolean
  onSelectionChange?: (selection: ModelSelectionConfig) => void
  onScopedCommandApprovalChange?: (mode: RuntimeCommandApprovalMode) => void
  onSelectionBlocked?: (
    reason: ModelCompatibilityDisabledReason | 'locked',
    model?: UnifiedModel | null
  ) => void
}

export const DEFAULT_MODEL_SCOPE_KEY = 'default'
export const EMPTY_MODEL_OPTIONS: ModelOptions = Object.freeze({})
export const PERSISTED_CLOUD_MODEL_TYPES = new Set(['public', 'user', 'group'])

/** Whether a fetched model still carries the configured group/public identity. */
export function matchesConfiguredCloudIdentity(
  model: UnifiedModel,
  config?: ModelSelectionConfig | null
): boolean {
  if (!config?.modelName) return false
  const options = config.options ?? {}
  const namespace = options[CLOUD_MODEL_NAMESPACE_OPTION]
  if (namespace && (model.namespace ?? 'default') !== namespace) return false
  const rawOwner = options[CLOUD_MODEL_RESOURCE_USER_ID_OPTION]
  if (rawOwner !== undefined && rawOwner !== '') {
    const owner = Number(rawOwner)
    if (Number.isFinite(owner) && model.resourceUserId !== owner) return false
  }
  return true
}

/** Whether a previously selected model still satisfies the configured selection. */
export function matchesConfiguredSelection(
  model: UnifiedModel,
  config?: ModelSelectionConfig | null
): boolean {
  return (
    model.name === config?.modelName &&
    model.type === config?.modelType &&
    matchesConfiguredCloudIdentity(model, config)
  )
}

/** Whether a selection names the configured persisted cloud model. */
export function isPersistedCloudSelection(
  model: UnifiedModel | null,
  config?: ModelSelectionConfig | null
): boolean {
  return Boolean(
    model &&
    config?.modelName === model.name &&
    config?.modelType === model.type &&
    PERSISTED_CLOUD_MODEL_TYPES.has(model.type) &&
    matchesConfiguredCloudIdentity(model, config)
  )
}

/** A 404/403 lookup is definitive; network and timeout failures are transient. */
export function isDefinitiveModelLookupError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403)
}

export function toSelectionConfig(
  model: UnifiedModel,
  options: ModelOptions
): ModelSelectionConfig {
  return {
    modelName: model.name,
    modelType: model.type,
    options: {
      ...options,
      ...modelSelectionIdentityOptions(model),
    },
  }
}

export function toDefaultModelSelectionConfig(options: ModelOptions): ModelSelectionConfig {
  return {
    modelName: '',
    modelType: null,
    options,
  }
}

export function areModelOptionsEqual(left: ModelOptions, right: ModelOptions): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => left[key] === right[key])
}

export function getSelectionKey(selectionConfig?: ModelSelectionConfig | null): string {
  const options = selectionConfig?.options ?? {}
  const optionsKey = Object.keys(options)
    .sort()
    .map(key => `${key}:${options[key]}`)
    .join('|')
  return [selectionConfig?.modelType ?? '', selectionConfig?.modelName ?? '', optionsKey].join('::')
}

export function deriveWorkbenchModelSelection(
  snapshot: import('./workbenchModelSource').ModelSnapshot,
  models: UnifiedModel[],
  {
    enabled = true,
    selectionReady = true,
    scopeKey = DEFAULT_MODEL_SCOPE_KEY,
    persistSelection = true,
    selectionConfig,
    defaultSelectionConfig,
    fallbackWhenConfiguredModelUnavailable = true,
  }: UseWorkbenchModelsOptions
) {
  const selectedModel = snapshot.selectedModelByScope[scopeKey] ?? null
  const selectedModelOptions = snapshot.selectedModelOptionsByScope[scopeKey] ?? EMPTY_MODEL_OPTIONS
  const currentDefaultModel =
    !selectionConfig?.modelName && selectedModel
      ? models.find(model => isSameModelSelection(model, selectedModel))
      : null
  const resolvedSelectionConfig =
    selectionConfig?.modelName &&
    (findModelForSelection(models, selectionConfig) || !fallbackWhenConfiguredModelUnavailable)
      ? selectionConfig
      : currentDefaultModel
        ? toSelectionConfig(currentDefaultModel, selectedModelOptions)
        : (defaultSelectionConfig?.(models) ?? selectionConfig ?? null)
  const commandApproval = selectionConfig?.options?.[RUNTIME_COMMAND_APPROVAL_OPTION]
  const effectiveSelectionConfig =
    commandApproval !== undefined &&
    resolvedSelectionConfig !== selectionConfig &&
    resolvedSelectionConfig
      ? {
          ...resolvedSelectionConfig,
          options: {
            ...resolvedSelectionConfig.options,
            [RUNTIME_COMMAND_APPROVAL_OPTION]: commandApproval,
          },
        }
      : resolvedSelectionConfig
  const selectionKey = getSelectionKey(effectiveSelectionConfig)
  const configuredModelAvailable = Boolean(
    effectiveSelectionConfig?.modelName && findModelForSelection(models, effectiveSelectionConfig)
  )
  const persistedCloudModelSelected =
    !fallbackWhenConfiguredModelUnavailable &&
    isPersistedCloudSelection(selectedModel, effectiveSelectionConfig)
  const selectedModelAvailable = Boolean(
    selectedModel &&
    (models.some(model => isSameModelSelection(model, selectedModel)) ||
      persistedCloudModelSelected)
  )
  const hasLocallySelectedReplacement =
    !persistSelection &&
    !configuredModelAvailable &&
    snapshot.locallySelectedReplacementByScope[scopeKey] &&
    selectedModelAvailable
  const selectionMatchesConfig = Boolean(
    hasLocallySelectedReplacement ||
    (selectedModel && findModelForSelection([selectedModel], effectiveSelectionConfig))
  )
  const configuredModelUnavailable = Boolean(
    effectiveSelectionConfig?.modelName &&
    !configuredModelAvailable &&
    !hasLocallySelectedReplacement &&
    !persistedCloudModelSelected &&
    !snapshot.transientLookupFailureByScope[scopeKey]
  )
  const isSelectionReady =
    enabled &&
    selectionReady &&
    snapshot.hasCompletedModelLoad &&
    !configuredModelUnavailable &&
    (snapshot.restoredSelectionKeyByScope[scopeKey] === selectionKey || selectionMatchesConfig)
  const modelSelectionDiagnostics: ModelSelectionDiagnostics = {
    scopeFingerprint: modelSelectionScopeFingerprint(scopeKey),
    configured: modelSelectionIdentityDiagnostics(selectionConfig),
    effective: modelSelectionIdentityDiagnostics(effectiveSelectionConfig),
    selected: modelSelectionIdentityDiagnostics(
      selectedModel ? toSelectionConfig(selectedModel, selectedModelOptions) : null
    ),
    catalogReady: enabled && snapshot.hasCompletedModelLoad,
    selectionReady: isSelectionReady,
  }
  return {
    selectedModel,
    selectedModelOptions,
    effectiveSelectionConfig,
    selectionKey,
    selectedModelAvailable,
    configuredModelUnavailable,
    isSelectionReady,
    modelSelectionDiagnostics,
  }
}
