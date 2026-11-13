import { useCallback } from 'react'
import { isSameModelSelection } from '@/lib/model-ui'
import { resolveAutomaticModel } from '@/features/workbench/runtimeModelSelection'
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
  hasSelectionForScope: (scopeKey: string) => boolean
  getSelectedModelForScope: (scopeKey: string) => UnifiedModel | null
  getSelectedModelOptionsForScope: (scopeKey: string) => ModelOptions
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
    getSelectedModelForScope,
    getSelectedModelOptionsForScope,
    hasSelectionForScope,
    models,
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
        taskSelection: task ? (task.modelSelection ?? null) : (handleSelection ?? null),
      }
    },
    [resolveTask]
  )
  const resolveRuntimeTaskModelSelection = useCallback(
    (address: RuntimeTaskAddress): RuntimeTaskModelSelectionControls => {
      const { selectionResolved, taskSelection } = resolveTaskModelConfig(address)
      const catalogTaskModel = findModelForSelection(models, taskSelection)
      const taskModel = catalogTaskModel ?? modelFromTaskSnapshot(taskSelection)
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      // Read the ref-backed value, not the last rendered state: a retry sent
      // immediately after picking a model must use that model. An entry with no
      // model (for example a restored placeholder) is not authoritative and
      // must not hide the conversation's saved model.
      const scopedModel = getSelectedModelForScope(scopeKey)
      const hasScopedModel = Boolean(scopedModel)
      const hasScopedOptions = hasSelectionForScope(scopeKey)
      // A restored or legacy conversation has no saved Wework model. It still
      // needs an explicit catalog model so the runtime does not fall back to an
      // unrelated native configuration. This catalog choice is shared by every
      // pane; it never borrows the focused pane's conversation selection.
      const automaticModel =
        selectionResolved && !taskSelection && !hasScopedModel
          ? resolveAutomaticModel(models)
          : null
      const effectiveModel = scopedModel ?? taskModel ?? automaticModel
      const hasUsableSelection = selectionResolved || hasScopedModel
      // Validate the saved selection, including its provider identity, rather
      // than the synthesized snapshot. For a picked model, prefer the refreshed
      // catalog copy's compatibility flag but do not require the catalog to
      // contain it yet: a just-created model can be missing from a stale list.
      const scopedCatalogModel = scopedModel
        ? models.find(model => isSameModelSelection(model, scopedModel))
        : null
      const selectedModelAvailable = hasScopedModel
        ? Boolean(
            scopedModel &&
            !(scopedCatalogModel?.compatibilityDisabled ?? scopedModel.compatibilityDisabled)
          )
        : catalogTaskModel
          ? !catalogTaskModel.compatibilityDisabled
          : Boolean(automaticModel)
      const scopedModelOptions = hasScopedOptions ? getSelectedModelOptionsForScope(scopeKey) : null
      return {
        // A model chosen in this pane is authoritative even before the task
        // summary arrives. An empty scoped entry is not.
        selectionResolved: hasUsableSelection,
        // A resolved conversation whose saved model was deleted is not ready
        // to send, but it must stay recoverable: the selector remains usable
        // so the user can choose a replacement.
        selectionReady: hasUsableSelection && selectedModelAvailable,
        taskSelection,
        activeModel: taskModel,
        ...((resolveTask(address)?.runtimeHandle ?? address.runtimeHandle)?.modelProviderRouting ===
        'thread'
          ? { supportsModelProviderSwitch: true }
          : {}),
        selectedModel: effectiveModel,
        // An options-only scoped entry must not drop saved routing options.
        selectedModelOptions:
          scopedModelOptions === null
            ? (taskSelection?.options ?? {})
            : hasScopedModel
              ? scopedModelOptions
              : { ...(taskSelection?.options ?? {}), ...scopedModelOptions },
      }
    },
    [
      getSelectedModelForScope,
      getSelectedModelOptionsForScope,
      hasSelectionForScope,
      models,
      resolveTask,
      resolveTaskModelConfig,
      userId,
    ]
  )
  const ensureTaskSelection = useCallback(
    (address: RuntimeTaskAddress) => {
      const scopeKey = runtimeTaskModelScopeKey(userId, address)
      if (!hasSelectionForScope(scopeKey)) {
        const selection = resolveRuntimeTaskModelSelection(address)
        // Seeding an unavailable saved model would make it look catalog-backed on
        // the next resolve: its synthesized snapshot has no compatibility flag.
        // Leave the scope unseeded so availability keeps coming from the task.
        if (selection.selectionReady) {
          setSelectionForScope(
            scopeKey,
            selection.selectedModel,
            selection.selectedModelOptions,
            selection.taskSelection
          )
        }
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
