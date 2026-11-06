import type { ModelSelectionConfig } from '@/types/api'

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
