import { useCallback } from 'react'
import type {
  ModelOptions,
  ModelSelectionConfig,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import type { RuntimeTaskModelSelectionControls } from './workbenchContextTypes'
import { findRuntimeTask } from './workbenchRuntimeHelpers'
import { findModelForSelection, modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { getRuntimeTaskChatScopeKey } from './workbenchProviderHelpers'

interface RuntimeTaskModelStore {
  models: UnifiedModel[]
  selectedModelByScope: Record<string, UnifiedModel | null>
  selectedModelOptionsByScope: Record<string, ModelOptions>
  hasSelectionForScope: (scopeKey: string) => boolean
  setSelectionForScope: (
    scopeKey: string,
    model: UnifiedModel | null,
    options?: ModelOptions,
    restoredSelectionConfig?: ModelSelectionConfig | null
  ) => void
  setSelectedModelForScope: (scopeKey: string, model: UnifiedModel | null) => void
  setSelectedModelAndOptionsForScope: (
    scopeKey: string,
    model: UnifiedModel,
    options: ModelOptions
  ) => void
  setSelectedModelOptionForScope: (scopeKey: string, optionId: string, value: string) => void
}

interface UseRuntimeTaskModelSelectionOptions {
  userId: number
  runtimeWork: RuntimeWorkListResponse | null
  modelStore: RuntimeTaskModelStore
}

function runtimeTaskModelScopeKey(userId: number, address: RuntimeTaskAddress): string {
  return `user:${userId}:${getRuntimeTaskChatScopeKey(address)}`
}

function modelFromTaskSnapshot(selection: ModelSelectionConfig | null): UnifiedModel | null {
  if (!selection?.modelName || !selection.modelType) return null

  const resourceUserIdValue = selection.options?.weworkCloudModelResourceUserId
  const resourceUserId = resourceUserIdValue ? Number(resourceUserIdValue) : null
  return {
    name: selection.modelName,
    displayName: selection.modelName,
    modelId: selection.modelName,
    type: selection.modelType,
    provider: selection.modelType === 'runtime' ? 'local' : 'cloud',
    ...(selection.options?.weworkCloudModelNamespace
      ? { namespace: selection.options.weworkCloudModelNamespace }
      : {}),
    ...(resourceUserId !== null && Number.isSafeInteger(resourceUserId) ? { resourceUserId } : {}),
  }
}

export function useRuntimeTaskModelSelection({
  userId,
  runtimeWork,
  modelStore,
}: UseRuntimeTaskModelSelectionOptions) {
  const {
    hasSelectionForScope,
    models,
    selectedModelByScope,
    selectedModelOptionsByScope,
    setSelectedModelAndOptionsForScope,
    setSelectedModelForScope,
    setSelectedModelOptionForScope,
    setSelectionForScope,
  } = modelStore
  const taskSelectionConfig = useCallback(
    (address: RuntimeTaskAddress) =>
      findRuntimeTask(runtimeWork, address)?.modelSelection ??
      modelSelectionFromRuntimeHandle(address.runtimeHandle) ??
      null,
    [runtimeWork]
  )
  const resolveRuntimeTaskModelSelection = useCallback(
    (address: RuntimeTaskAddress): RuntimeTaskModelSelectionControls => {
      const taskSelection = taskSelectionConfig(address)
      const taskModel =
        findModelForSelection(models, taskSelection) ?? modelFromTaskSnapshot(taskSelection)
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      const hasScopedSelection = Object.prototype.hasOwnProperty.call(
        selectedModelByScope,
        scopeKey
      )
      return {
        taskSelection,
        activeModel: taskModel,
        selectedModel: hasScopedSelection ? (selectedModelByScope[scopeKey] ?? null) : taskModel,
        selectedModelOptions: hasScopedSelection
          ? (selectedModelOptionsByScope[scopeKey] ?? {})
          : (taskSelection?.options ?? {}),
      }
    },
    [models, selectedModelByScope, selectedModelOptionsByScope, taskSelectionConfig, userId]
  )
  const ensureTaskSelection = useCallback(
    (address: RuntimeTaskAddress) => {
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      if (!hasSelectionForScope(scopeKey)) {
        const selection = resolveRuntimeTaskModelSelection(address)
        setSelectionForScope(
          scopeKey,
          selection.selectedModel,
          selection.selectedModelOptions,
          taskSelectionConfig(address)
        )
      }
      return scopeKey
    },
    [
      hasSelectionForScope,
      resolveRuntimeTaskModelSelection,
      setSelectionForScope,
      taskSelectionConfig,
      userId,
    ]
  )
  const setRuntimeTaskSelectedModel = useCallback(
    (address: RuntimeTaskAddress, model: UnifiedModel | null) => {
      setSelectedModelForScope(ensureTaskSelection(address), model)
    },
    [ensureTaskSelection, setSelectedModelForScope]
  )
  const setRuntimeTaskSelectedModelAndOptions = useCallback(
    (address: RuntimeTaskAddress, model: UnifiedModel, options: ModelOptions) => {
      setSelectedModelAndOptionsForScope(ensureTaskSelection(address), model, options)
    },
    [ensureTaskSelection, setSelectedModelAndOptionsForScope]
  )
  const setRuntimeTaskSelectedModelOption = useCallback(
    (address: RuntimeTaskAddress, optionId: string, value: string) => {
      setSelectedModelOptionForScope(ensureTaskSelection(address), optionId, value)
    },
    [ensureTaskSelection, setSelectedModelOptionForScope]
  )

  return {
    resolveRuntimeTaskModelSelection,
    setRuntimeTaskSelectedModel,
    setRuntimeTaskSelectedModelAndOptions,
    setRuntimeTaskSelectedModelOption,
  }
}
