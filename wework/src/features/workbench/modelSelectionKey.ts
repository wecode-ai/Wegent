import type { ModelSelectionConfig } from '@/types/api'

/** Stable identity for a persisted task model selection. */
export function modelSelectionKey(selection?: ModelSelectionConfig | null): string {
  const options = selection?.options ?? {}
  const optionsKey = Object.keys(options)
    .sort()
    .map(key => `${key}:${options[key]}`)
    .join('|')
  return [selection?.modelType ?? '', selection?.modelName ?? '', optionsKey].join('::')
}
