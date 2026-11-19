import { useCallback, useId, useMemo, useSyncExternalStore } from 'react'
import { useDOMEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import {
  RUNTIME_COMMAND_APPROVAL_OPTION,
  runtimeCommandApprovalMode,
} from '@wegent/chat-core/runtime-permission'
import { logModelLoading } from '@/lib/model-loading-diagnostics'
import {
  getDefaultModelOptions,
  inferModelFamily,
  isSameModelSelection,
  normalizeModelOptions,
} from '@/lib/model-ui'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import {
  modelSelectionIdentityDiagnostics,
  modelSelectionScopeFingerprint,
} from './modelSelectionDiagnostics'
import type { ModelOptions, ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { createWorkbenchModelSource } from './workbenchModelSource'
import {
  DEFAULT_MODEL_SCOPE_KEY,
  deriveWorkbenchModelSelection,
  getSelectionKey,
  toSelectionConfig,
  toDefaultModelSelectionConfig,
  type UseWorkbenchModelsOptions,
} from './workbenchModelSelection'

export function useWorkbenchModels({
  api,
  locked,
  enabled = true,
  filterModel,
  scopeKey = DEFAULT_MODEL_SCOPE_KEY,
  persistSelection = true,
  selectionConfig,
  defaultSelectionConfig,
  fallbackWhenConfiguredModelUnavailable = true,
  selectionReady = true,
  onSelectionChange,
  onScopedCommandApprovalChange,
  onSelectionBlocked,
}: UseWorkbenchModelsOptions) {
  const traceId = useId()
  const source = useMemo(() => createWorkbenchModelSource(api, traceId), [api, traceId])
  const derive = useCallback(
    () =>
      deriveWorkbenchModelSelection(source.getSnapshot(), source.getModels(filterModel), {
        api,
        locked,
        enabled,
        filterModel,
        scopeKey,
        persistSelection,
        selectionConfig,
        defaultSelectionConfig,
        fallbackWhenConfiguredModelUnavailable,
        selectionReady,
      }),
    [
      source,
      api,
      locked,
      enabled,
      filterModel,
      scopeKey,
      persistSelection,
      selectionConfig,
      defaultSelectionConfig,
      fallbackWhenConfiguredModelUnavailable,
      selectionReady,
    ]
  )
  const resolveInput = useCallback(() => {
    const view = derive()
    return {
      enabled,
      selectionReady,
      scopeKey,
      models: source.getModels(filterModel),
      config: view.effectiveSelectionConfig,
      selectionKey: view.selectionKey,
      fallback: fallbackWhenConfiguredModelUnavailable,
      configuredFingerprint: modelSelectionIdentityDiagnostics(selectionConfig)?.fingerprint ?? 0,
      filterModel,
      isSelectionReady: view.isSelectionReady,
      selectedModelAvailable: view.selectedModelAvailable,
    }
  }, [
    derive,
    enabled,
    selectionReady,
    scopeKey,
    source,
    filterModel,
    fallbackWhenConfiguredModelUnavailable,
    selectionConfig,
  ])
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, resolveInput),
    [source, resolveInput]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const {
    selectedModel,
    selectedModelOptions,
    selectionKey,
    selectedModelAvailable,
    configuredModelUnavailable,
    isSelectionReady,
    modelSelectionDiagnostics,
  } = derive()
  const models = source.getModels(filterModel)
  const refreshModels = source.refreshModels
  useDOMEvent<Event>(
    'window',
    LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
    () => {
      api.refresh?.({ invalidateLocal: true })
      void source.loadModels()
    },
    { enabled }
  )
  useWindowEvent(
    'online',
    () => {
      void source.loadModels()
    },
    { enabled }
  )
  const applySelectedModelForScope = useCallback(
    (
      targetScopeKey: string,
      model: UnifiedModel | null,
      resolveOptions: (
        model: UnifiedModel | null,
        currentModel: UnifiedModel | null,
        currentOptions: ModelOptions
      ) => ModelOptions,
      persist: boolean
    ) => {
      if (locked) {
        onSelectionBlocked?.('locked', model)
        return
      }
      if (model?.compatibilityDisabled) {
        onSelectionBlocked?.(model.compatibilityDisabledReason ?? 'runtime_family_mismatch', model)
        return
      }
      const currentSelection = source.getSelectedModelForScope(targetScopeKey)
      const currentOptions = source.getSelectedModelOptionsForScope(targetScopeKey)
      const nextOptions = resolveOptions(model, currentSelection, currentOptions)
      const commandApproval = currentOptions[RUNTIME_COMMAND_APPROVAL_OPTION]
      if (model && commandApproval !== undefined) {
        nextOptions[RUNTIME_COMMAND_APPROVAL_OPTION] ??= commandApproval
      }
      logModelLoading(traceId, 'workbench.selection_changed', {
        scopeFingerprint: modelSelectionScopeFingerprint(targetScopeKey),
        previousModelFingerprint:
          modelSelectionIdentityDiagnostics(
            currentSelection ? toSelectionConfig(currentSelection, currentOptions) : null
          )?.fingerprint ?? 0,
        selectedModelFingerprint:
          modelSelectionIdentityDiagnostics(model ? toSelectionConfig(model, nextOptions) : null)
            ?.fingerprint ?? 0,
        persist,
      })
      if (
        currentSelection &&
        model &&
        model.type === 'runtime' &&
        isSameModelSelection(currentSelection, model) &&
        currentOptions.runnerModelProvider
      ) {
        nextOptions.runnerModelProvider = currentOptions.runnerModelProvider
      } else {
        delete nextOptions.runnerModelProvider
      }
      // A manual choice must win over any restore lookup that is still in
      // flight; its late result or a 404 must not overwrite this selection.
      source.select(targetScopeKey, model, nextOptions, !persist && Boolean(model))
      if (model && persist) {
        onSelectionChange?.(toSelectionConfig(model, nextOptions))
      }
    },
    [source, locked, onSelectionBlocked, onSelectionChange, traceId]
  )

  const setSelectedModelForScope = useCallback(
    (targetScopeKey: string, model: UnifiedModel | null, persist = false) => {
      applySelectedModelForScope(
        targetScopeKey,
        model,
        (nextModel, currentModel, currentOptions) => {
          const currentFamily = currentModel ? inferModelFamily(currentModel) : null
          const nextFamily = nextModel ? inferModelFamily(nextModel) : null
          return currentFamily === nextFamily
            ? normalizeModelOptions(nextModel, currentOptions)
            : getDefaultModelOptions(nextModel)
        },
        persist
      )
    },
    [applySelectedModelForScope]
  )

  const setSelectedModel = useCallback(
    (model: UnifiedModel | null) => {
      setSelectedModelForScope(scopeKey, model, persistSelection)
    },
    [persistSelection, scopeKey, setSelectedModelForScope]
  )

  const setSelectedModelAndOptionsForScope = useCallback(
    (targetScopeKey: string, model: UnifiedModel, options: ModelOptions, persist = false) => {
      applySelectedModelForScope(
        targetScopeKey,
        model,
        nextModel => normalizeModelOptions(nextModel, options),
        persist
      )
    },
    [applySelectedModelForScope]
  )

  const setSelectedModelAndOptions = useCallback(
    (model: UnifiedModel, options: ModelOptions) => {
      setSelectedModelAndOptionsForScope(scopeKey, model, options, persistSelection)
    },
    [persistSelection, scopeKey, setSelectedModelAndOptionsForScope]
  )

  const setSelectedModelOptionForScope = useCallback(
    (targetScopeKey: string, optionId: string, value: string, persist = false) => {
      if (locked) return
      const nextOptions = {
        ...source.getSelectedModelOptionsForScope(targetScopeKey),
        [optionId]: value,
      }
      const currentModel = source.getSelectedModelForScope(targetScopeKey)
      if (optionId === 'collaborationMode') {
        logModelLoading(traceId, 'workbench.collaboration_mode_selected', {
          runtimeTaskScope: targetScopeKey.includes(':runtime:'),
          planMode: value === 'plan',
          persist,
        })
      }
      source.option(targetScopeKey, nextOptions)
      if (!persist) {
        if (optionId === RUNTIME_COMMAND_APPROVAL_OPTION) {
          onScopedCommandApprovalChange?.(runtimeCommandApprovalMode(nextOptions))
        }
        return
      }
      if (currentModel) {
        onSelectionChange?.(toSelectionConfig(currentModel, nextOptions))
      } else {
        onSelectionChange?.(toDefaultModelSelectionConfig(nextOptions))
      }
    },
    [source, locked, onSelectionChange, onScopedCommandApprovalChange, traceId]
  )

  const setSelectedModelOption = useCallback(
    (optionId: string, value: string) => {
      setSelectedModelOptionForScope(scopeKey, optionId, value, persistSelection)
    },
    [persistSelection, scopeKey, setSelectedModelOptionForScope]
  )

  const setSelectionForScope = useCallback(
    (
      targetScopeKey: string,
      model: UnifiedModel | null,
      options: ModelOptions = {},
      restoredSelectionConfig?: ModelSelectionConfig | null,
      persist = false
    ) => {
      const nextOptions = model ? normalizeModelOptions(model, options) : options
      const persistedSelection = persist && model ? toSelectionConfig(model, nextOptions) : null
      logModelLoading(traceId, 'workbench.selection_seeded', {
        scopeFingerprint: modelSelectionScopeFingerprint(targetScopeKey),
        selectedModelFingerprint:
          modelSelectionIdentityDiagnostics(model ? toSelectionConfig(model, nextOptions) : null)
            ?.fingerprint ?? 0,
        persist,
      })
      const restoredSelectionKey =
        restoredSelectionConfig === undefined
          ? persistedSelection
            ? getSelectionKey(persistedSelection)
            : selectionKey
          : getSelectionKey(restoredSelectionConfig)
      source.seed(targetScopeKey, model, nextOptions, restoredSelectionKey)
      if (persistedSelection) {
        onSelectionChange?.(persistedSelection)
      }
    },
    [source, onSelectionChange, selectionKey, traceId]
  )

  const getSelectedModel = useCallback(
    () => source.getSelectedModelForScope(scopeKey),
    [source, scopeKey]
  )
  const getSelectedModelOptions = useCallback(
    () => source.getSelectedModelOptionsForScope(scopeKey),
    [source, scopeKey]
  )
  const { hasSelectionForScope, getSelectedModelForScope, getSelectedModelOptionsForScope } = source

  return {
    models,
    refreshModels,
    selectedModel,
    selectedModelOptions,
    modelSelectionDiagnostics,
    isCatalogReady: enabled && snapshot.hasCompletedModelLoad,
    selectedModelAvailable,
    isSelectionReady,
    isConfiguredModelUnavailable: configuredModelUnavailable,
    setSelectedModel,
    setSelectedModelAndOptions,
    setSelectedModelOption,
    setSelectedModelForScope,
    setSelectedModelAndOptionsForScope,
    setSelectedModelOptionForScope,
    setSelectionForScope,
    getSelectedModel,
    getSelectedModelOptions,
    hasSelectionForScope,
    getSelectedModelForScope,
    getSelectedModelOptionsForScope,
    selectedModelByScope: snapshot.selectedModelByScope,
    selectedModelOptionsByScope: snapshot.selectedModelOptionsByScope,
    selectionRevision: snapshot.selectionRevision,
    isLoading: enabled && snapshot.isLoading,
    error: enabled ? snapshot.error : null,
  }
}
