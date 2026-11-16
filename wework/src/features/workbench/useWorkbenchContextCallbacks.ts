import type { RuntimeTaskSummary } from '@/types/api'
import type { useWorkbenchModels } from './useWorkbenchModels'
// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import { useCallback } from 'react'
import {
  applyModelContextWindowOverride,
  findModelForSelection,
  modelSelectionFromRuntimeHandle,
} from './runtimeContextUsage'
export function useResolveRuntimeContextUsage({
  resolveRuntimeTaskSummary,
  modelSelection,
}: {
  resolveRuntimeTaskSummary: (
    address: RuntimeTaskAddress | null | undefined
  ) => RuntimeTaskSummary | null
  modelSelection: ReturnType<typeof useWorkbenchModels>
}) {
  return useCallback(
    (address: RuntimeTaskAddress, usage: RuntimeContextUsage): RuntimeContextUsage => {
      const taskSelection =
        resolveRuntimeTaskSummary(address)?.modelSelection ??
        modelSelectionFromRuntimeHandle(address.runtimeHandle) ??
        null
      const selectedModel = modelSelection.selectedModel
      const taskModel = findModelForSelection(modelSelection.models, taskSelection)
      const matchingSelectedModel =
        taskSelection?.modelName &&
        selectedModel?.name === taskSelection.modelName &&
        (!taskSelection.modelType || selectedModel.type === taskSelection.modelType)
          ? selectedModel
          : null

      return applyModelContextWindowOverride(usage, taskModel ?? matchingSelectedModel)
    },
    [modelSelection.models, modelSelection.selectedModel, resolveRuntimeTaskSummary]
  )
}

export function useResolveModelForAddress({
  resolveRuntimeTaskSummary,
  modelSelection,
}: {
  resolveRuntimeTaskSummary: (
    address: RuntimeTaskAddress | null | undefined
  ) => RuntimeTaskSummary | null
  modelSelection: ReturnType<typeof useWorkbenchModels>
}) {
  return useCallback(
    (address: RuntimeTaskAddress): UnifiedModel | null => {
      const taskSelection =
        resolveRuntimeTaskSummary(address)?.modelSelection ??
        modelSelectionFromRuntimeHandle(address.runtimeHandle) ??
        null
      const selectedModel = modelSelection.selectedModel
      const taskModel = findModelForSelection(modelSelection.models, taskSelection)
      const matchingSelectedModel =
        taskSelection?.modelName &&
        selectedModel?.name === taskSelection.modelName &&
        (!taskSelection.modelType || selectedModel.type === taskSelection.modelType)
          ? selectedModel
          : null
      return taskModel ?? matchingSelectedModel
    },
    [modelSelection.models, modelSelection.selectedModel, resolveRuntimeTaskSummary]
  )
}
