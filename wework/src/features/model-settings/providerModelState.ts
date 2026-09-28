import type { LocalModelConfig, LocalModelCatalogSnapshot } from './localModelSettings'

// Runtime-only projection. Connection definitions and keys are never written to localStorage.
let configurations: LocalModelConfig[] = []

/** Read the runtime-only provider projection without accessing persistent browser storage. */
export function getProviderModelConfigs(): LocalModelConfig[] {
  return configurations
}

/** Replace the derived provider model list after a validated configuration load. */
export function replaceProviderModelConfigs(next: LocalModelConfig[]): void {
  configurations = next
}

/** Mark only catalog entries whose configuration version matches the acknowledged snapshot. */
export function markProviderModelCatalogReady(
  snapshot: readonly LocalModelCatalogSnapshot[]
): void {
  const versions = new Map(snapshot.map(model => [model.id, model.updatedAt]))
  configurations = configurations.map(model =>
    versions.get(model.id) === model.updatedAt ? { ...model, catalogReady: true } : model
  )
}
