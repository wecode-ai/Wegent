import type { ModelApi } from '@/api/models'
import type { ModelOptions, ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { isSameModelSelection, isSupportedModelFamily, normalizeModelOptions } from '@/lib/model-ui'
import {
  logModelLoading,
  observeModelLoadingMainThread,
  traceModelLoading,
} from '@/lib/model-loading-diagnostics'
import {
  modelSelectionIdentityDiagnostics,
  modelSelectionScopeFingerprint,
} from './modelSelectionDiagnostics'
import { findModelForSelection } from './runtimeContextUsage'
import {
  EMPTY_MODEL_OPTIONS,
  PERSISTED_CLOUD_MODEL_TYPES,
  areModelOptionsEqual,
  getSelectionKey,
  isDefinitiveModelLookupError,
  isPersistedCloudSelection,
  matchesConfiguredCloudIdentity,
  matchesConfiguredSelection,
  toSelectionConfig,
} from './workbenchModelSelection'

export interface ModelSnapshot {
  availableModels: UnifiedModel[]
  selectedModelByScope: Record<string, UnifiedModel | null>
  selectedModelOptionsByScope: Record<string, ModelOptions>
  selectionRevision: number
  hasCompletedModelLoad: boolean
  isLoading: boolean
  error: Error | null
  restoredSelectionKeyByScope: Record<string, string | null>
  locallySelectedReplacementByScope: Record<string, boolean>
  transientLookupFailureByScope: Record<string, boolean>
}

export interface WorkbenchModelInput {
  enabled: boolean
  selectionReady: boolean
  scopeKey: string
  models: UnifiedModel[]
  config: ModelSelectionConfig | null
  selectionKey: string
  fallback: boolean
  configuredFingerprint: number
  filterModel?: (model: UnifiedModel) => boolean
  isSelectionReady: boolean
  selectedModelAvailable: boolean
}

/** Catalog requests and scoped selections share one authoritative, synchronously readable snapshot. */
export function createWorkbenchModelSource(api: ModelApi, traceId: string) {
  let snapshot: ModelSnapshot = {
    availableModels: [],
    selectedModelByScope: {},
    selectedModelOptionsByScope: {},
    selectionRevision: 0,
    hasCompletedModelLoad: false,
    isLoading: false,
    error: null,
    restoredSelectionKeyByScope: {},
    locallySelectedReplacementByScope: {},
    transientLookupFailureByScope: {},
  }
  let input: WorkbenchModelInput | undefined
  const listeners = new Set<() => void>()
  let loadRevision = 0
  let syncGeneration = 0
  const selectionRevisions: Record<string, number> = {}
  let validated: { scopeKey: string; selectionKey: string; models: UnifiedModel[] } | null = null
  let stopApi: (() => void) | undefined
  let catalogAttached = false
  let apiAttached = false
  let stopObservation: (() => void) | undefined
  const patch = (value: Partial<ModelSnapshot>) => {
    snapshot = { ...snapshot, ...value }
  }
  let resolveInput: (() => WorkbenchModelInput) | undefined
  let filteredCatalog:
    | { raw: UnifiedModel[]; filter: WorkbenchModelInput['filterModel']; models: UnifiedModel[] }
    | undefined
  const getModels = (filter?: WorkbenchModelInput['filterModel']) => {
    if (
      !filteredCatalog ||
      filteredCatalog.raw !== snapshot.availableModels ||
      filteredCatalog.filter !== filter
    )
      filteredCatalog = {
        raw: snapshot.availableModels,
        filter,
        models: filter ? snapshot.availableModels.filter(filter) : snapshot.availableModels,
      }
    return filteredCatalog.models
  }
  const emit = () => {
    if (resolveInput) configure(resolveInput())
    listeners.forEach(listener => listener())
  }
  const invalidate = (scope: string) => {
    selectionRevisions[scope] = (selectionRevisions[scope] ?? 0) + 1
  }
  const writeSelection = (scope: string, model: UnifiedModel | null, options: ModelOptions) => {
    patch({
      selectedModelByScope: { ...snapshot.selectedModelByScope, [scope]: model },
      selectedModelOptionsByScope: { ...snapshot.selectedModelOptionsByScope, [scope]: options },
      selectionRevision: snapshot.selectionRevision + 1,
    })
  }
  const restore = async (request: WorkbenchModelInput, cancelled: () => boolean) => {
    const { scopeKey, models, config, fallback, configuredFingerprint } = request
    const revision = selectionRevisions[scopeKey] ?? 0
    const stale = () => cancelled() || (selectionRevisions[scopeKey] ?? 0) !== revision
    let model = findModelForSelection(models, config)
    let transientFailure = false
    let verified = Boolean(model)
    if (
      !model &&
      !fallback &&
      config?.modelName &&
      config.modelType &&
      PERSISTED_CLOUD_MODEL_TYPES.has(config.modelType) &&
      api.getModel
    ) {
      try {
        model = await api.getModel(config.modelName, config.modelType, 'wework', 'llm')
        if (stale()) return false
        verified = true
        if (
          !model ||
          model.type !== config.modelType ||
          !matchesConfiguredCloudIdentity(model, config)
        )
          model = null
      } catch (error) {
        if (stale()) return false
        if (isDefinitiveModelLookupError(error)) {
          model = null
          verified = true
        } else {
          const previous = snapshot.selectedModelByScope[scopeKey] ?? null
          if (previous && !matchesConfiguredSelection(previous, config))
            writeSelection(scopeKey, null, EMPTY_MODEL_OPTIONS)
          model = snapshot.selectedModelByScope[scopeKey] ?? null
          transientFailure = !model
        }
      }
      if (stale()) return false
    }
    if (transientFailure) {
      patch({
        transientLookupFailureByScope: {
          ...snapshot.transientLookupFailureByScope,
          [scopeKey]: true,
        },
      })
      return false
    }
    if (verified) validated = { scopeKey, selectionKey: getSelectionKey(config), models }
    const transient = { ...snapshot.transientLookupFailureByScope }
    delete transient[scopeKey]
    const options = model
      ? normalizeModelOptions(model, config?.options ?? {})
      : (config?.options ?? {})
    logModelLoading(traceId, 'workbench.selection_restored', {
      runtimeTaskScope: scopeKey.includes(':runtime:'),
      planMode: options.collaborationMode === 'plan',
      scopeFingerprint: modelSelectionScopeFingerprint(scopeKey),
      configuredModelFingerprint: configuredFingerprint,
      restoredModelFingerprint: modelSelectionIdentityDiagnostics(config)?.fingerprint ?? 0,
      selectedModelFingerprint:
        modelSelectionIdentityDiagnostics(model ? toSelectionConfig(model, options) : null)
          ?.fingerprint ?? 0,
    })
    writeSelection(scopeKey, model, options)
    patch({
      transientLookupFailureByScope: transient,
      locallySelectedReplacementByScope: {
        ...snapshot.locallySelectedReplacementByScope,
        [scopeKey]: false,
      },
    })
    return true
  }
  const scheduleSync = () => {
    const request = input
    const generation = ++syncGeneration
    if (!request?.enabled || !request.selectionReady) return
    const cancelled = () => generation !== syncGeneration || !listeners.size
    void (async () => {
      await Promise.resolve()
      if (cancelled()) return
      const { scopeKey, models, config, selectionKey, fallback } = request
      const current = snapshot.selectedModelByScope[scopeKey] ?? null
      const hasSelection =
        Object.hasOwn(snapshot.selectedModelByScope, scopeKey) ||
        Object.hasOwn(snapshot.selectedModelOptionsByScope, scopeKey)
      const restored = snapshot.restoredSelectionKeyByScope[scopeKey] === selectionKey
      const configuredAvailable = Boolean(
        config?.modelName && findModelForSelection(models, config)
      )
      const inCatalog = Boolean(
        current && models.some(model => isSameModelSelection(model, current))
      )
      const manual = Boolean(
        snapshot.locallySelectedReplacementByScope[scopeKey] && current && inCatalog
      )
      const needsValidation = Boolean(
        current && !fallback && isPersistedCloudSelection(current, config) && !inCatalog
      )
      const verified =
        validated?.scopeKey === scopeKey &&
        validated.selectionKey === selectionKey &&
        validated.models === models
      if (
        !manual &&
        (!hasSelection ||
          !restored ||
          (configuredAvailable && !current) ||
          (needsValidation && !verified))
      ) {
        const didRestore = await restore(request, cancelled)
        if (cancelled()) return
        if (!didRestore) {
          emit()
          return
        }
      }
      if (snapshot.restoredSelectionKeyByScope[scopeKey] !== selectionKey)
        patch({
          restoredSelectionKeyByScope: {
            ...snapshot.restoredSelectionKeyByScope,
            [scopeKey]: selectionKey,
          },
        })
      emit()
    })()
  }
  const reconcile = (models: UnifiedModel[]) => {
    const selected = { ...snapshot.selectedModelByScope }
    const options = { ...snapshot.selectedModelOptionsByScope }
    let changed = false
    for (const [scope, current] of Object.entries(selected)) {
      if (!current) continue
      const refreshed = models.find(model => isSameModelSelection(model, current))
      if (!refreshed) continue
      if (current !== refreshed) {
        selected[scope] = refreshed
        changed = true
      }
      const normalized = normalizeModelOptions(refreshed, options[scope] ?? {})
      if (!areModelOptionsEqual(options[scope] ?? {}, normalized)) {
        options[scope] = normalized
        changed = true
      }
    }
    if (changed)
      patch({
        selectedModelByScope: selected,
        selectedModelOptionsByScope: options,
        selectionRevision: snapshot.selectionRevision + 1,
      })
  }
  const loadModels = async () => {
    if (!input?.enabled || !listeners.size) return
    const revision = ++loadRevision
    const loadTraceId = `${traceId}-${revision}`
    const filter = input.filterModel
    patch({ isLoading: true, error: null })
    emit()
    try {
      const response = await traceModelLoading(loadTraceId, 'workbench.catalog', () =>
        api.listModels()
      )
      logModelLoading(loadTraceId, 'workbench.catalog_received', {
        modelCount: response.data.length,
        discarded: revision !== loadRevision || !listeners.size,
      })
      if (revision !== loadRevision || !listeners.size) return
      const models = response.data.filter(isSupportedModelFamily)
      reconcile(filter ? models.filter(filter) : models)
      patch({ availableModels: models })
    } catch (error) {
      if (revision === loadRevision && listeners.size)
        patch({ error: error instanceof Error ? error : new Error('Failed to load models') })
    } finally {
      if (revision === loadRevision && listeners.size) {
        patch({ hasCompletedModelLoad: true, isLoading: false })
        emit()
      }
    }
  }
  const detachApi = () => {
    stopApi?.()
    stopApi = undefined
    apiAttached = false
  }
  const detachCatalog = () => {
    loadRevision += 1
    detachApi()
    catalogAttached = false
  }
  function configure(next: WorkbenchModelInput) {
    const previous = input
    input = next
    const catalogChanged =
      previous?.enabled !== next.enabled || previous.filterModel !== next.filterModel
    if (catalogChanged && catalogAttached) detachCatalog()
    if (next.enabled && !catalogAttached) {
      catalogAttached = true
      queueMicrotask(() => {
        if (catalogAttached && listeners.size) void loadModels()
      })
    }
    if (next.enabled && !apiAttached) {
      apiAttached = true
      stopApi = api.subscribe?.(() => {
        void loadModels()
      })
    }
    if (previous?.enabled !== next.enabled || previous.selectionReady !== next.selectionReady)
      logModelLoading(traceId, 'workbench.gates', {
        enabled: next.enabled,
        selectionReady: next.selectionReady,
      })
    if (
      previous?.isSelectionReady !== next.isSelectionReady ||
      previous.selectedModelAvailable !== next.selectedModelAvailable ||
      previous.models.length !== next.models.length
    )
      logModelLoading(traceId, 'workbench.selection', {
        isSelectionReady: next.isSelectionReady,
        selectedModelAvailable: next.selectedModelAvailable,
        modelCount: next.models.length,
      })
    if (
      !previous ||
      previous.scopeKey !== next.scopeKey ||
      previous.models !== next.models ||
      previous.selectionKey !== next.selectionKey ||
      previous.fallback !== next.fallback ||
      previous.enabled !== next.enabled ||
      previous.selectionReady !== next.selectionReady
    )
      scheduleSync()
  }
  return {
    getSnapshot: () => snapshot,
    getModels,
    loadModels,
    refreshModels: () => {
      if (input?.enabled) {
        api.refresh?.()
        void loadModels()
      }
    },
    subscribe(notify: () => void, resolve: () => WorkbenchModelInput) {
      listeners.add(notify)
      if (!stopObservation) stopObservation = observeModelLoadingMainThread(traceId)
      resolveInput = resolve
      configure(resolve())
      return () => {
        listeners.delete(notify)
        if (!listeners.size) detachApi()
        queueMicrotask(() => {
          if (listeners.size) return
          detachCatalog()
          syncGeneration += 1
          stopObservation?.()
          stopObservation = undefined
          input = undefined
          resolveInput = undefined
        })
      }
    },
    select(scope: string, model: UnifiedModel | null, options: ModelOptions, replacement: boolean) {
      invalidate(scope)
      writeSelection(scope, model, options)
      patch({
        locallySelectedReplacementByScope: {
          ...snapshot.locallySelectedReplacementByScope,
          [scope]: replacement,
        },
      })
      emit()
      scheduleSync()
    },
    option(scope: string, options: ModelOptions) {
      invalidate(scope)
      patch({
        selectedModelOptionsByScope: { ...snapshot.selectedModelOptionsByScope, [scope]: options },
        selectionRevision: snapshot.selectionRevision + 1,
      })
      emit()
      scheduleSync()
    },
    seed(scope: string, model: UnifiedModel | null, options: ModelOptions, key: string) {
      invalidate(scope)
      writeSelection(scope, model, options)
      patch({
        restoredSelectionKeyByScope: { ...snapshot.restoredSelectionKeyByScope, [scope]: key },
      })
      emit()
      scheduleSync()
    },
    getSelectedModelForScope: (scope: string) => snapshot.selectedModelByScope[scope] ?? null,
    getSelectedModelOptionsForScope: (scope: string) =>
      snapshot.selectedModelOptionsByScope[scope] ?? EMPTY_MODEL_OPTIONS,
    hasSelectionForScope: (scope: string) => Object.hasOwn(snapshot.selectedModelByScope, scope),
  }
}
