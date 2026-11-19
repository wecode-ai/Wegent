import type { ModelOptions, ModelSelectionConfig, UnifiedModel } from '@/types/api'

export interface ModelSelectionIdentityDiagnostics {
  modelName: string
  modelType: ModelSelectionConfig['modelType']
  namespace?: string
  resourceUserId?: string
  codexProviderId?: string
  fingerprint: number
}

export interface ModelSelectionDiagnostics {
  scopeFingerprint: number
  configured: ModelSelectionIdentityDiagnostics | null
  effective: ModelSelectionIdentityDiagnostics | null
  selected: ModelSelectionIdentityDiagnostics | null
  catalogReady: boolean
  selectionReady: boolean
}

/** Correlate local diagnostic events without recording scope keys or configuration secrets. */
export function modelSelectionScopeFingerprint(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  }
  return hash >>> 0
}

/** Extract only model identity fields; never retain arbitrary options or authentication data. */
export function modelSelectionIdentityDiagnostics(
  selection?: ModelSelectionConfig | null
): ModelSelectionIdentityDiagnostics | null {
  if (!selection?.modelName) return null
  const options = selection.options ?? {}
  const identity = {
    modelName: selection.modelName,
    modelType: selection.modelType ?? null,
    ...(options.weworkCloudModelNamespace ? { namespace: options.weworkCloudModelNamespace } : {}),
    ...(options.weworkCloudModelResourceUserId
      ? { resourceUserId: options.weworkCloudModelResourceUserId }
      : {}),
    ...(options.codexProviderId ? { codexProviderId: options.codexProviderId } : {}),
  }
  return {
    ...identity,
    fingerprint: modelSelectionScopeFingerprint(JSON.stringify(identity)),
  }
}

interface ComposerModelSelectionSource {
  scopeKey?: string
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  getSelectedModel?: () => UnifiedModel | null
  getSelectedModelOptions?: () => ModelOptions
  modelSelectionDiagnostics?: ModelSelectionDiagnostics
  selectionRevision?: number
  isModelSelectionReady?: boolean
}

/** Capture render and ref identities without retaining options, prompts or scope contents. */
export function composerModelSelectionDiagnostics(source: ComposerModelSelectionSource) {
  const identity = (model: UnifiedModel | null, options: ModelOptions) =>
    modelSelectionIdentityDiagnostics(
      model ? { modelName: model.name, modelType: model.type, options } : null
    )
  const diagnostics = source.modelSelectionDiagnostics
  const identities = {
    configured: diagnostics?.configured,
    effective: diagnostics?.effective,
    selected: diagnostics?.selected,
    rendered: identity(source.selectedModel, source.selectedModelOptions),
    live: identity(
      source.getSelectedModel ? source.getSelectedModel() : source.selectedModel,
      source.getSelectedModelOptions
        ? source.getSelectedModelOptions()
        : source.selectedModelOptions
    ),
  }
  const details: Record<string, boolean | number | string | null> = {
    scopeFingerprint: modelSelectionScopeFingerprint(source.scopeKey ?? ''),
    modelScopeFingerprint: diagnostics?.scopeFingerprint ?? null,
    selectionRevision: source.selectionRevision ?? null,
    isModelSelectionReady: source.isModelSelectionReady ?? null,
    isModelCatalogReady: diagnostics?.catalogReady ?? null,
    hasLiveModelGetter: Boolean(source.getSelectedModel),
    hasLiveOptionsGetter: Boolean(source.getSelectedModelOptions),
  }
  for (const [prefix, value] of Object.entries(identities)) {
    details[`${prefix}ModelName`] = value?.modelName.slice(0, 80) ?? null
    details[`${prefix}ModelType`] = value?.modelType ?? null
    details[`${prefix}ProviderId`] = value?.codexProviderId?.slice(0, 80) ?? null
    details[`${prefix}Fingerprint`] = value?.fingerprint ?? null
  }
  return details
}

/** Optional diagnostics cannot prevent admission when an inspected reader fails. */
export function captureComposerModelSelectionDiagnostics(source: ComposerModelSelectionSource) {
  try {
    return composerModelSelectionDiagnostics(source)
  } catch {
    return { modelSelectionCaptureFailed: true }
  }
}
