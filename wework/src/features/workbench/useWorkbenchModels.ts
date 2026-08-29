import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getDefaultModelOptions,
  inferModelFamily,
  isSameModelSelection,
  isSupportedModelFamily,
  normalizeModelOptions,
} from '@/lib/model-ui'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { findModelForSelection } from './runtimeContextUsage'
import { modelSelectionIdentityOptions } from './runtimeModelSelection'
import { WORKBENCH_MODELS_CHANGED_EVENT } from './workbenchCloudDataEvents'
import type {
  ModelCompatibilityDisabledReason,
  ModelOptions,
  ModelSelectionConfig,
  UnifiedModel,
  UnifiedModelListResponse,
} from '@/types/api'

interface WorkbenchModelApi {
  listModels: () => Promise<UnifiedModelListResponse>
}

interface UseWorkbenchModelsOptions {
  api: WorkbenchModelApi
  locked: boolean
  enabled?: boolean
  filterModel?: (model: UnifiedModel) => boolean
  scopeKey?: string
  persistSelection?: boolean
  selectionConfig?: ModelSelectionConfig | null
  defaultSelectionConfig?: (models: UnifiedModel[]) => ModelSelectionConfig | null
  fallbackWhenConfiguredModelUnavailable?: boolean
  selectionReady?: boolean
  onSelectionChange?: (selection: ModelSelectionConfig) => void
  onSelectionBlocked?: (
    reason: ModelCompatibilityDisabledReason | 'locked',
    model?: UnifiedModel | null
  ) => void
}

const DEFAULT_MODEL_SCOPE_KEY = 'default'

function toSelectionConfig(model: UnifiedModel, options: ModelOptions): ModelSelectionConfig {
  return {
    modelName: model.name,
    modelType: model.type,
    options: {
      ...options,
      ...modelSelectionIdentityOptions(model),
    },
  }
}

function toDefaultModelSelectionConfig(options: ModelOptions): ModelSelectionConfig {
  return {
    modelName: '',
    modelType: null,
    options,
  }
}

function areModelOptionsEqual(left: ModelOptions, right: ModelOptions): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => left[key] === right[key])
}

function getSelectionKey(selectionConfig?: ModelSelectionConfig | null): string {
  const options = selectionConfig?.options ?? {}
  const optionsKey = Object.keys(options)
    .sort()
    .map(key => `${key}:${options[key]}`)
    .join('|')
  return [selectionConfig?.modelType ?? '', selectionConfig?.modelName ?? '', optionsKey].join('::')
}

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
  onSelectionBlocked,
}: UseWorkbenchModelsOptions) {
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const models = useMemo(
    () => (filterModel ? availableModels.filter(filterModel) : availableModels),
    [availableModels, filterModel]
  )
  const [selectedModelByScope, setSelectedModelByScope] = useState<
    Record<string, UnifiedModel | null>
  >({})
  const [selectedModelOptionsByScope, setSelectedModelOptionsByScope] = useState<
    Record<string, ModelOptions>
  >({})
  const selectedModel = selectedModelByScope[scopeKey] ?? null
  const selectedModelOptions = selectedModelOptionsByScope[scopeKey] ?? {}
  const selectedModelRef = useRef<Record<string, UnifiedModel | null>>({})
  const selectedModelOptionsRef = useRef<Record<string, ModelOptions>>({})
  const modelLoadRevisionRef = useRef(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [restoredSelectionKeyByScope, setRestoredSelectionKeyByScope] = useState<
    Record<string, string | null>
  >({})
  const [locallySelectedReplacementByScope, setLocallySelectedReplacementByScope] = useState<
    Record<string, boolean>
  >({})
  const effectiveSelectionConfig = useMemo(() => {
    if (selectionConfig?.modelName) {
      if (
        findModelForSelection(models, selectionConfig) ||
        !fallbackWhenConfiguredModelUnavailable
      ) {
        return selectionConfig
      }
    }
    return defaultSelectionConfig?.(models) ?? selectionConfig ?? null
  }, [defaultSelectionConfig, fallbackWhenConfiguredModelUnavailable, models, selectionConfig])
  const selectionKey = useMemo(
    () => getSelectionKey(effectiveSelectionConfig),
    [effectiveSelectionConfig]
  )
  const configuredModelAvailable = Boolean(
    effectiveSelectionConfig?.modelName && findModelForSelection(models, effectiveSelectionConfig)
  )
  const selectedModelAvailable = Boolean(
    selectedModel && models.some(model => isSameModelSelection(model, selectedModel))
  )
  const hasLocallySelectedReplacement = Boolean(
    !persistSelection &&
    !configuredModelAvailable &&
    locallySelectedReplacementByScope[scopeKey] &&
    selectedModelAvailable
  )
  const selectionMatchesConfig = Boolean(
    hasLocallySelectedReplacement ||
    (selectedModel && findModelForSelection([selectedModel], effectiveSelectionConfig))
  )
  const configuredModelUnavailable = Boolean(
    effectiveSelectionConfig?.modelName &&
    !configuredModelAvailable &&
    !hasLocallySelectedReplacement
  )
  const isSelectionReady = useMemo(
    () =>
      !enabled ||
      (selectionReady &&
        !isLoading &&
        !configuredModelUnavailable &&
        (restoredSelectionKeyByScope[scopeKey] === selectionKey || selectionMatchesConfig)),
    [
      configuredModelUnavailable,
      enabled,
      isLoading,
      restoredSelectionKeyByScope,
      scopeKey,
      selectionMatchesConfig,
      selectionKey,
      selectionReady,
    ]
  )

  const restoreSelection = useCallback(
    (availableModels: UnifiedModel[], nextSelectionConfig?: ModelSelectionConfig | null) => {
      const model = findModelForSelection(availableModels, nextSelectionConfig)
      const nextOptions = model
        ? normalizeModelOptions(model, nextSelectionConfig?.options ?? {})
        : (nextSelectionConfig?.options ?? {})
      selectedModelRef.current[scopeKey] = model
      selectedModelOptionsRef.current[scopeKey] = nextOptions
      setSelectedModelByScope(current => {
        if (current[scopeKey] === model) return current
        return { ...current, [scopeKey]: model }
      })
      setSelectedModelOptionsByScope(current => {
        if (areModelOptionsEqual(current[scopeKey] ?? {}, nextOptions)) return current
        return { ...current, [scopeKey]: nextOptions }
      })
      setLocallySelectedReplacementByScope(current =>
        current[scopeKey] ? { ...current, [scopeKey]: false } : current
      )
    },
    [scopeKey]
  )

  const reconcileSelectedModels = useCallback((nextModels: UnifiedModel[]) => {
    const selectedModelPatch: Record<string, UnifiedModel> = {}
    const selectedOptionsPatch: Record<string, ModelOptions> = {}

    for (const [selectedScopeKey, currentModel] of Object.entries(selectedModelRef.current)) {
      if (!currentModel) continue
      const refreshedModel = nextModels.find(model => isSameModelSelection(model, currentModel))
      if (!refreshedModel) continue

      if (refreshedModel !== currentModel) {
        selectedModelPatch[selectedScopeKey] = refreshedModel
      }

      const currentOptions = selectedModelOptionsRef.current[selectedScopeKey] ?? {}
      const normalizedOptions = normalizeModelOptions(refreshedModel, currentOptions)
      if (!areModelOptionsEqual(currentOptions, normalizedOptions)) {
        selectedOptionsPatch[selectedScopeKey] = normalizedOptions
      }
    }

    if (Object.keys(selectedModelPatch).length > 0) {
      selectedModelRef.current = {
        ...selectedModelRef.current,
        ...selectedModelPatch,
      }
      setSelectedModelByScope(current => ({ ...current, ...selectedModelPatch }))
    }

    if (Object.keys(selectedOptionsPatch).length > 0) {
      selectedModelOptionsRef.current = {
        ...selectedModelOptionsRef.current,
        ...selectedOptionsPatch,
      }
      setSelectedModelOptionsByScope(current => ({ ...current, ...selectedOptionsPatch }))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    async function loadModels() {
      const revision = ++modelLoadRevisionRef.current
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.listModels()
        if (!cancelled && revision === modelLoadRevisionRef.current) {
          const filtered = response.data.filter(isSupportedModelFamily)
          reconcileSelectedModels(filterModel ? filtered.filter(filterModel) : filtered)
          setAvailableModels(filtered)
        }
      } catch (nextError) {
        if (!cancelled && revision === modelLoadRevisionRef.current) {
          setError(nextError instanceof Error ? nextError : new Error('Failed to load models'))
        }
      } finally {
        if (!cancelled && revision === modelLoadRevisionRef.current) {
          setIsLoading(false)
        }
      }
    }

    void loadModels()
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, loadModels)
    window.addEventListener(WORKBENCH_MODELS_CHANGED_EVENT, loadModels)
    return () => {
      cancelled = true
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, loadModels)
      window.removeEventListener(WORKBENCH_MODELS_CHANGED_EVENT, loadModels)
    }
  }, [api, enabled, filterModel, reconcileSelectedModels])

  useEffect(() => {
    if (!enabled || !selectionReady) {
      return
    }

    let cancelled = false

    async function syncSelection() {
      await Promise.resolve()
      if (!cancelled) {
        const hasScopeSelection =
          Object.prototype.hasOwnProperty.call(selectedModelRef.current, scopeKey) ||
          Object.prototype.hasOwnProperty.call(selectedModelOptionsRef.current, scopeKey)
        const scopeSelectionAlreadyRestored = restoredSelectionKeyByScope[scopeKey] === selectionKey
        const configuredModelAvailable = Boolean(
          effectiveSelectionConfig?.modelName &&
          findModelForSelection(models, effectiveSelectionConfig)
        )
        if (
          !hasScopeSelection ||
          !scopeSelectionAlreadyRestored ||
          (configuredModelAvailable && !selectedModelRef.current[scopeKey])
        ) {
          restoreSelection(models, effectiveSelectionConfig)
        }
        setRestoredSelectionKeyByScope(current =>
          current[scopeKey] === selectionKey ? current : { ...current, [scopeKey]: selectionKey }
        )
      }
    }

    syncSelection()
    return () => {
      cancelled = true
    }
  }, [
    effectiveSelectionConfig,
    enabled,
    models,
    restoreSelection,
    restoredSelectionKeyByScope,
    scopeKey,
    selectionKey,
    selectionReady,
  ])

  const applySelectedModel = useCallback(
    (
      model: UnifiedModel | null,
      resolveOptions: (
        model: UnifiedModel | null,
        currentModel: UnifiedModel | null,
        currentOptions: ModelOptions
      ) => ModelOptions
    ) => {
      if (locked) {
        onSelectionBlocked?.('locked', model)
        return
      }
      if (model?.compatibilityDisabled) {
        onSelectionBlocked?.(model.compatibilityDisabledReason ?? 'runtime_family_mismatch', model)
        return
      }
      const currentSelection = selectedModelRef.current[scopeKey] ?? null
      const currentOptions = selectedModelOptionsRef.current[scopeKey] ?? {}
      const nextOptions = resolveOptions(model, currentSelection, currentOptions)
      selectedModelRef.current[scopeKey] = model
      selectedModelOptionsRef.current[scopeKey] = nextOptions
      setSelectedModelByScope(current => ({ ...current, [scopeKey]: model }))
      setSelectedModelOptionsByScope(current => ({ ...current, [scopeKey]: nextOptions }))
      setLocallySelectedReplacementByScope(current => ({
        ...current,
        [scopeKey]: !persistSelection && Boolean(model),
      }))
      if (model && persistSelection) {
        onSelectionChange?.(toSelectionConfig(model, nextOptions))
      }
    },
    [locked, onSelectionBlocked, onSelectionChange, persistSelection, scopeKey]
  )

  const setSelectedModel = useCallback(
    (model: UnifiedModel | null) => {
      applySelectedModel(model, (nextModel, currentModel, currentOptions) => {
        const currentFamily = currentModel ? inferModelFamily(currentModel) : null
        const nextFamily = nextModel ? inferModelFamily(nextModel) : null
        return currentFamily === nextFamily
          ? normalizeModelOptions(nextModel, currentOptions)
          : getDefaultModelOptions(nextModel)
      })
    },
    [applySelectedModel]
  )

  const setSelectedModelAndOptions = useCallback(
    (model: UnifiedModel, options: ModelOptions) => {
      applySelectedModel(model, nextModel => normalizeModelOptions(nextModel, options))
    },
    [applySelectedModel]
  )

  const setSelectedModelOption = useCallback(
    (optionId: string, value: string) => {
      if (locked) return
      const nextOptions = {
        ...(selectedModelOptionsRef.current[scopeKey] ?? {}),
        [optionId]: value,
      }
      const currentModel = selectedModelRef.current[scopeKey] ?? null
      selectedModelOptionsRef.current[scopeKey] = nextOptions
      setSelectedModelOptionsByScope(current => ({ ...current, [scopeKey]: nextOptions }))
      if (!persistSelection) return
      if (currentModel) {
        onSelectionChange?.(toSelectionConfig(currentModel, nextOptions))
      } else {
        onSelectionChange?.(toDefaultModelSelectionConfig(nextOptions))
      }
    },
    [locked, onSelectionChange, persistSelection, scopeKey]
  )

  const setSelectionForScope = useCallback(
    (targetScopeKey: string, model: UnifiedModel | null, options: ModelOptions = {}) => {
      const nextOptions = model ? normalizeModelOptions(model, options) : options
      selectedModelRef.current[targetScopeKey] = model
      selectedModelOptionsRef.current[targetScopeKey] = nextOptions
      setSelectedModelByScope(current => ({ ...current, [targetScopeKey]: model }))
      setSelectedModelOptionsByScope(current => ({ ...current, [targetScopeKey]: nextOptions }))
      setRestoredSelectionKeyByScope(current => ({ ...current, [targetScopeKey]: selectionKey }))
    },
    [selectionKey]
  )

  const getSelectedModel = useCallback(() => selectedModelRef.current[scopeKey] ?? null, [scopeKey])
  const getSelectedModelOptions = useCallback(
    () => selectedModelOptionsRef.current[scopeKey] ?? {},
    [scopeKey]
  )

  return {
    models,
    selectedModel,
    selectedModelOptions,
    isSelectionReady,
    isConfiguredModelUnavailable: configuredModelUnavailable,
    setSelectedModel,
    setSelectedModelAndOptions,
    setSelectedModelOption,
    setSelectionForScope,
    getSelectedModel,
    getSelectedModelOptions,
    isLoading: enabled && isLoading,
    error: enabled ? error : null,
  }
}
