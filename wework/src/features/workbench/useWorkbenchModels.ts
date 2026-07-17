import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ModelCompatibilityFamily,
  areModelCompatibilityFamiliesCompatible,
  areModelsProtocolCompatible,
  getDefaultModelOptions,
  getModelCompatibilityFamily,
  inferModelFamily,
  isSupportedModelFamily,
  normalizeModelOptions,
} from '@/lib/model-ui'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
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
  scopeKey?: string
  persistSelection?: boolean
  selectionConfig?: ModelSelectionConfig | null
  compatibilityConfig?: ModelSelectionConfig | null
  compatibilityFamily?: ModelCompatibilityFamily | null
  defaultSelectionConfig?: (models: UnifiedModel[]) => ModelSelectionConfig | null
  selectionReady?: boolean
  onSelectionChange?: (selection: ModelSelectionConfig) => void
  onSelectionBlocked?: (
    reason: ModelCompatibilityDisabledReason | 'locked',
    model?: UnifiedModel | null
  ) => void
}

const DEFAULT_MODEL_SCOPE_KEY = 'default'

function findConfiguredModel(
  models: UnifiedModel[],
  selectionConfig?: ModelSelectionConfig | null
): UnifiedModel | null {
  if (!selectionConfig?.modelName) return null
  return (
    models.find(
      model =>
        model.name === selectionConfig.modelName &&
        (!selectionConfig.modelType || model.type === selectionConfig.modelType)
    ) ?? null
  )
}

function toSelectionConfig(model: UnifiedModel, options: ModelOptions): ModelSelectionConfig {
  return {
    modelName: model.name,
    modelType: model.type,
    options,
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

function getSelectionKey(
  models: UnifiedModel[],
  selectionConfig?: ModelSelectionConfig | null
): string {
  const modelsKey = models.map(model => `${model.type}:${model.name}`).join('|')
  const options = selectionConfig?.options ?? {}
  const optionsKey = Object.keys(options)
    .sort()
    .map(key => `${key}:${options[key]}`)
    .join('|')
  return [
    modelsKey,
    selectionConfig?.modelType ?? '',
    selectionConfig?.modelName ?? '',
    optionsKey,
  ].join('::')
}

function isSameModel(left: UnifiedModel, right: UnifiedModel): boolean {
  return left.name === right.name && left.type === right.type
}

function getCompatibilityDisabledReason(
  currentModel: UnifiedModel,
  nextModel: UnifiedModel
): ModelCompatibilityDisabledReason | null {
  if (isSameModel(currentModel, nextModel)) return null

  const currentFamily = getModelCompatibilityFamily(currentModel)
  if (!currentFamily) return 'missing_current_runtime_family'

  const nextFamily = getModelCompatibilityFamily(nextModel)
  if (!nextFamily) return 'missing_target_runtime_family'

  return areModelsProtocolCompatible(currentModel, nextModel) ? null : 'runtime_family_mismatch'
}

function getCompatibilityDisabledReasonForFamily(
  currentFamily: ModelCompatibilityFamily,
  nextModel: UnifiedModel
): ModelCompatibilityDisabledReason | null {
  const nextFamily = getModelCompatibilityFamily(nextModel)
  if (!nextFamily) return 'missing_target_runtime_family'

  return areModelCompatibilityFamiliesCompatible(currentFamily, nextFamily)
    ? null
    : 'runtime_family_mismatch'
}

function annotateModelsByCompatibility(
  models: UnifiedModel[],
  compatibilityConfig?: ModelSelectionConfig | null,
  compatibilityFamily?: ModelCompatibilityFamily | null
): UnifiedModel[] {
  if (compatibilityFamily) {
    return models.map(model => {
      const compatibilityDisabledReason = getCompatibilityDisabledReasonForFamily(
        compatibilityFamily,
        model
      )
      if (!compatibilityDisabledReason) return model
      return {
        ...model,
        compatibilityDisabled: true,
        compatibilityDisabledReason,
      }
    })
  }

  const currentModel = findConfiguredModel(models, compatibilityConfig)
  if (!currentModel) return models
  return models.map(model => {
    const compatibilityDisabledReason = getCompatibilityDisabledReason(currentModel, model)
    if (!compatibilityDisabledReason) return model
    return {
      ...model,
      compatibilityDisabled: true,
      compatibilityDisabledReason,
    }
  })
}

export function useWorkbenchModels({
  api,
  locked,
  scopeKey = DEFAULT_MODEL_SCOPE_KEY,
  persistSelection = true,
  selectionConfig,
  compatibilityConfig,
  compatibilityFamily,
  defaultSelectionConfig,
  selectionReady = true,
  onSelectionChange,
  onSelectionBlocked,
}: UseWorkbenchModelsOptions) {
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const models = useMemo(
    () => annotateModelsByCompatibility(availableModels, compatibilityConfig, compatibilityFamily),
    [availableModels, compatibilityConfig, compatibilityFamily]
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
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [restoredSelectionKeyByScope, setRestoredSelectionKeyByScope] = useState<
    Record<string, string | null>
  >({})
  const effectiveSelectionConfig = useMemo(() => {
    if (selectionConfig?.modelName) {
      return selectionConfig
    }
    return defaultSelectionConfig?.(models) ?? selectionConfig ?? null
  }, [defaultSelectionConfig, models, selectionConfig])
  const selectionKey = useMemo(
    () => getSelectionKey(models, effectiveSelectionConfig),
    [models, effectiveSelectionConfig]
  )
  const selectionMatchesConfig = Boolean(
    effectiveSelectionConfig?.modelName &&
    selectedModel &&
    selectedModel.name === effectiveSelectionConfig.modelName &&
    (!effectiveSelectionConfig.modelType ||
      selectedModel.type === effectiveSelectionConfig.modelType)
  )
  const isSelectionReady = useMemo(
    () =>
      selectionReady &&
      !isLoading &&
      (restoredSelectionKeyByScope[scopeKey] === selectionKey || selectionMatchesConfig),
    [
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
      const model = findConfiguredModel(availableModels, nextSelectionConfig)
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
    },
    [scopeKey]
  )

  useEffect(() => {
    let cancelled = false

    async function loadModels() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.listModels()
        if (!cancelled) {
          const filtered = response.data.filter(isSupportedModelFamily)
          setAvailableModels(filtered)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError : new Error('Failed to load models'))
        }
      } finally {
        if (!cancelled) {
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
  }, [api])

  useEffect(() => {
    if (!selectionReady) {
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
        if (!hasScopeSelection || !scopeSelectionAlreadyRestored) {
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
    setSelectedModel,
    setSelectedModelAndOptions,
    setSelectedModelOption,
    setSelectionForScope,
    getSelectedModel,
    getSelectedModelOptions,
    isLoading,
    error,
  }
}
