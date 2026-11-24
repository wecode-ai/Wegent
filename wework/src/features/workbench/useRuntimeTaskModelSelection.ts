import { useCallback } from 'react'
import { isSameModelSelection } from '@/lib/model-ui'
import { resolveAutomaticModel } from '@/features/workbench/runtimeModelSelection'
import { modelFromTaskSnapshot } from '@wegent/chat-core/runtime-model-selection'
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
  /**
   * The model store validates the active task's saved selection, including a
   * persisted cloud reference that the discovery catalog no longer lists.
   * Return its readiness for the addressed task, or null for another task.
   */
  resolveActiveTaskSelectionReady?: (address: RuntimeTaskAddress) => boolean | null
}

function runtimeTaskModelScopeKey(userId: number, address: RuntimeTaskAddress): string {
  return `user:${userId}:${getRuntimeTaskChatScopeKey(address)}`
}

export function useRuntimeTaskModelSelection({
  userId,
  resolveTask,
  modelStore,
  resolveActiveTaskSelectionReady,
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
  const resolveRuntimeTaskModelSelection = useCallback(
    (
      address: RuntimeTaskAddress,
      task = resolveTask(address)
    ): RuntimeTaskModelSelectionControls => {
      const handleSelection = modelSelectionFromRuntimeHandle(address.runtimeHandle)
      const selectionResolved = Boolean(task || handleSelection)
      // A loaded summary without a selection uses the runtime's native model.
      const taskSelection = task ? (task.modelSelection ?? null) : (handleSelection ?? null)
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
      // The provider validates the focused task's persisted selection, which can
      // resolve a hidden cloud model that the discovery catalog omits. Reuse that
      // validation instead of treating the absent catalog entry as unavailable.
      const activeTaskSelectionReady = resolveActiveTaskSelectionReady?.(address) === true
      return {
        // A model chosen in this pane is authoritative even before the task
        // summary arrives. An empty scoped entry is not.
        selectionResolved: hasUsableSelection || activeTaskSelectionReady,
        // A resolved conversation whose saved model was deleted is not ready
        // to send, but it must stay recoverable: the selector remains usable
        // so the user can choose a replacement.
        selectionReady: activeTaskSelectionReady || (hasUsableSelection && selectedModelAvailable),
        taskSelection,
        activeModel: taskModel,
        ...((task?.runtimeHandle ?? address.runtimeHandle)?.modelProviderRouting === 'thread'
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
      resolveActiveTaskSelectionReady,
      resolveTask,
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
