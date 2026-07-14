import type { ModelType, UnifiedModel } from '@/types/api'

const MODEL_EXECUTION_CONFIG_KEY = 'weworkExecution'

export type HybridModelSource = 'local' | 'cloud'

export interface ModelExecutionOverride {
  source: HybridModelSource
  modelName: string
  modelType: ModelType
  modelNamespace?: string
  resourceUserId?: number
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function withModelExecutionOverride(
  model: UnifiedModel,
  override: ModelExecutionOverride
): UnifiedModel {
  return {
    ...model,
    config: {
      ...(model.config ?? {}),
      [MODEL_EXECUTION_CONFIG_KEY]: override,
    },
  }
}

export function getModelExecutionOverride(
  model?: UnifiedModel | null
): ModelExecutionOverride | null {
  const config = recordValue(model?.config)
  const override = recordValue(config?.[MODEL_EXECUTION_CONFIG_KEY])
  if (!override) return null
  if (
    (override.source === 'local' || override.source === 'cloud') &&
    typeof override.modelName === 'string' &&
    (override.modelType === 'public' ||
      override.modelType === 'user' ||
      override.modelType === 'group' ||
      override.modelType === 'runtime')
  ) {
    return {
      source: override.source,
      modelName: override.modelName,
      modelType: override.modelType,
      ...(typeof override.modelNamespace === 'string'
        ? { modelNamespace: override.modelNamespace }
        : {}),
      ...(typeof override.resourceUserId === 'number'
        ? { resourceUserId: override.resourceUserId }
        : {}),
    }
  }
  return null
}

export function resolveModelExecutionSelection(model: UnifiedModel): {
  modelName: string
  modelType: ModelType
  modelNamespace?: string
  resourceUserId?: number
} {
  const override = getModelExecutionOverride(model)
  if (override) {
    return {
      modelName: override.modelName,
      modelType: override.modelType,
      modelNamespace: override.modelNamespace,
      resourceUserId: override.resourceUserId,
    }
  }
  return {
    modelName: model.name,
    modelType: model.type,
    modelNamespace: model.namespace,
    resourceUserId: model.resourceUserId,
  }
}
