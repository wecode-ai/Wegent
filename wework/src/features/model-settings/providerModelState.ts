import type { LocalModelConfig, LocalModelCatalogSnapshot } from './localModelSettings'

// Runtime-only projection. Connection definitions and keys are never written to localStorage.
let configurations: LocalModelConfig[] = []

export function getProviderModelConfigs(): LocalModelConfig[] {
  return configurations
}

export function replaceProviderModelConfigs(next: LocalModelConfig[]): void {
  configurations = next
}

export function markProviderModelCatalogReady(
  snapshot: readonly LocalModelCatalogSnapshot[]
): void {
  const versions = new Map(snapshot.map(model => [model.id, model.updatedAt]))
  configurations = configurations.map(model =>
    versions.get(model.id) === model.updatedAt ? { ...model, catalogReady: true } : model
  )
}
