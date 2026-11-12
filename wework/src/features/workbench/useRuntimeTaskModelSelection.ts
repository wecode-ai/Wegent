import { useCallback } from 'react'
import type {
  ModelOptions,
  ModelSelectionConfig,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  UnifiedModel,
} from '@/types/api'
import type { RuntimeTaskModelSelectionControls } from './workbenchContextTypes'
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
    restoredSelectionConfig?: ModelSelectionConfig | null,
    persist?: boolean
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
  resolveTask: (address: RuntimeTaskAddress) => RuntimeTaskSummary | null
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
  resolveTask,
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
  const resolveTaskModelConfig = useCallback(
    (address: RuntimeTaskAddress) => {
      const task = resolveTask(address)
      const handleSelection = modelSelectionFromRuntimeHandle(address.runtimeHandle)
      return {
        // A loaded summary without a selection is authoritative: the
        // conversation deliberately uses the runtime's native model.
        selectionResolved: Boolean(task || handleSelection),
        taskSelection: task?.modelSelection ?? handleSelection ?? null,
      }
    },
    [resolveTask]
  )
  const taskSelectionConfig = useCallback(
    (address: RuntimeTaskAddress) => resolveTaskModelConfig(address).taskSelection,
    [resolveTaskModelConfig]
  )
  const resolveRuntimeTaskModelSelection = useCallback(
    (address: RuntimeTaskAddress): RuntimeTaskModelSelectionControls => {
      const { selectionResolved, taskSelection } = resolveTaskModelConfig(address)
      const taskModel =
        findModelForSelection(models, taskSelection) ?? modelFromTaskSnapshot(taskSelection)
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      const hasScopedSelection = Object.prototype.hasOwnProperty.call(
        selectedModelByScope,
        scopeKey
      )
      const scopedModel = hasScopedSelection ? (selectedModelByScope[scopeKey] ?? null) : null
      return {
        // A model chosen in this pane is authoritative even before the task
        // summary arrives. An empty scoped entry is not.
        selectionResolved: selectionResolved || Boolean(scopedModel),
        taskSelection,
        activeModel: taskModel,
        ...((resolveTask(address)?.runtimeHandle ?? address.runtimeHandle)?.modelProviderRouting ===
        'thread'
          ? { supportsModelProviderSwitch: true }
          : {}),
        selectedModel: hasScopedSelection ? scopedModel : taskModel,
        selectedModelOptions: hasScopedSelection
          ? (selectedModelOptionsByScope[scopeKey] ?? {})
          : (taskSelection?.options ?? {}),
      }
    },
    [
      models,
      resolveTask,
      resolveTaskModelConfig,
      selectedModelByScope,
      selectedModelOptionsByScope,
      userId,
    ]
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
          selection.taskSelection
        )
      }
      return scopeKey
    },
    [hasSelectionForScope, resolveRuntimeTaskModelSelection, setSelectionForScope, userId]
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
