import { useCallback, useState } from 'react'
import { localModelIdFromModelName } from '@/features/model-settings/localModelSettings'
import type {
  ModelOptions,
  ModelSelectionConfig,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  UnifiedModel,
} from '@/types/api'
import type { RuntimeTaskModelSelectionControls } from './workbenchContextTypes'
import { findModelForSelection, modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { getRuntimeTaskChatScopeKey } from './workbenchProviderHelpers'
import { modelSelectionKey } from './modelSelectionKey'

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

interface AcceptedActiveModel {
  model: UnifiedModel
  selection: ModelSelectionConfig
  previousSelectionKey: string
}

function selectionFromAcceptedSwitch(
  model: UnifiedModel,
  execution: Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'>
): ModelSelectionConfig {
  return {
    modelName: execution.modelId ?? model.name,
    modelType: execution.modelType ?? model.type,
    options: execution.modelOptions ?? {},
  }
}

function runtimeTaskModelScopeKey(userId: number, address: RuntimeTaskAddress): string {
  return `user:${userId}:${getRuntimeTaskChatScopeKey(address)}`
}

function modelFromTaskSnapshot(selection: ModelSelectionConfig | null): UnifiedModel | null {
  if (!selection?.modelName || !selection.modelType) return null

  const providerType = selection.options?.codexProviderType
  const modelKind =
    selection.modelType !== 'runtime'
      ? null
      : localModelIdFromModelName(selection.modelName)
        ? 'model-interface'
        : providerType === 'official'
          ? 'codex-official'
          : providerType === 'provider'
            ? 'codex-provider'
            : null
  const resourceUserIdValue = selection.options?.weworkCloudModelResourceUserId
  const resourceUserId = resourceUserIdValue ? Number(resourceUserIdValue) : null
  return {
    name: selection.modelName,
    displayName: selection.modelName,
    modelId: selection.modelName,
    type: selection.modelType,
    provider: selection.modelType === 'runtime' ? 'local' : 'cloud',
    ...(modelKind ? { config: { weworkModelKind: modelKind } } : {}),
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
  const [acceptedActiveModelByScope, setAcceptedActiveModelByScope] = useState<
    Record<string, AcceptedActiveModel>
  >({})
  const taskSelectionConfig = useCallback(
    (address: RuntimeTaskAddress) =>
      resolveTask(address)?.modelSelection ??
      modelSelectionFromRuntimeHandle(address.runtimeHandle) ??
      null,
    [resolveTask]
  )
  const resolveRuntimeTaskModelSelection = useCallback(
    (address: RuntimeTaskAddress): RuntimeTaskModelSelectionControls => {
      const taskSelection = taskSelectionConfig(address)
      const taskModel =
        findModelForSelection(models, taskSelection) ?? modelFromTaskSnapshot(taskSelection)
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      const acceptedActiveModel = acceptedActiveModelByScope[scopeKey]
      const activeModel =
        acceptedActiveModel &&
        acceptedActiveModel.previousSelectionKey === modelSelectionKey(taskSelection)
          ? acceptedActiveModel.model
          : taskModel
      const activeModelSelection =
        acceptedActiveModel &&
        acceptedActiveModel.previousSelectionKey === modelSelectionKey(taskSelection)
          ? acceptedActiveModel.selection
          : taskSelection
      const hasScopedSelection = Object.prototype.hasOwnProperty.call(
        selectedModelByScope,
        scopeKey
      )
      return {
        taskSelection,
        activeModel,
        activeModelSelection,
        selectedModel: hasScopedSelection ? (selectedModelByScope[scopeKey] ?? null) : taskModel,
        selectedModelOptions: hasScopedSelection
          ? (selectedModelOptionsByScope[scopeKey] ?? {})
          : (taskSelection?.options ?? {}),
      }
    },
    [
      acceptedActiveModelByScope,
      models,
      selectedModelByScope,
      selectedModelOptionsByScope,
      taskSelectionConfig,
      userId,
    ]
  )
  const confirmRuntimeTaskActiveModel = useCallback(
    (
      address: RuntimeTaskAddress,
      model: UnifiedModel,
      execution: Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'>
    ) => {
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      const previousSelectionKey = modelSelectionKey(taskSelectionConfig(address))
      setAcceptedActiveModelByScope(current => ({
        ...current,
        [scopeKey]: {
          model,
          selection: selectionFromAcceptedSwitch(model, execution),
          previousSelectionKey,
        },
      }))
    },
    [taskSelectionConfig, userId]
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
    confirmRuntimeTaskActiveModel,
    setRuntimeTaskSelectedModel,
    setRuntimeTaskSelectedModelAndOptions,
    setRuntimeTaskSelectedModelOption,
  }
}
