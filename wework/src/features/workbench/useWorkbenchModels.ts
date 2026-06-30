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
  const [selectedModel, setSelectedModelState] = useState<UnifiedModel | null>(null)
  const [selectedModelOptions, setSelectedModelOptions] = useState<ModelOptions>({})
  const selectedModelRef = useRef<UnifiedModel | null>(null)
  const selectedModelOptionsRef = useRef<ModelOptions>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [restoredSelectionKey, setRestoredSelectionKey] = useState<string | null>(null)
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
      (restoredSelectionKey === selectionKey || selectionMatchesConfig),
    [isLoading, restoredSelectionKey, selectionMatchesConfig, selectionKey, selectionReady]
  )

  const restoreSelection = useCallback(
    (availableModels: UnifiedModel[], nextSelectionConfig?: ModelSelectionConfig | null) => {
      const model = findConfiguredModel(availableModels, nextSelectionConfig)
      const nextOptions = model
        ? normalizeModelOptions(model, nextSelectionConfig?.options ?? {})
        : (nextSelectionConfig?.options ?? {})
      selectedModelRef.current = model
      selectedModelOptionsRef.current = nextOptions
      setSelectedModelState(current => (current === model ? current : model))
      setSelectedModelOptions(current =>
        areModelOptionsEqual(current, nextOptions) ? current : nextOptions
      )
    },
    []
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

    loadModels()
    return () => {
      cancelled = true
    }
  }, [api, restoreSelection])

  useEffect(() => {
    if (!selectionReady) {
      return
    }

    let cancelled = false

    async function syncSelection() {
      await Promise.resolve()
      if (!cancelled) {
        restoreSelection(models, effectiveSelectionConfig)
        setRestoredSelectionKey(selectionKey)
      }
    }

    syncSelection()
    return () => {
      cancelled = true
    }
  }, [models, restoreSelection, effectiveSelectionConfig, selectionKey, selectionReady])

  const setSelectedModel = useCallback(
    (model: UnifiedModel | null) => {
      if (locked) {
        onSelectionBlocked?.('locked', model)
        return
      }
      if (model?.compatibilityDisabled) {
        onSelectionBlocked?.(model.compatibilityDisabledReason ?? 'runtime_family_mismatch', model)
        return
      }
      const currentSelection = selectedModelRef.current
      const currentFamily = currentSelection ? inferModelFamily(currentSelection) : null
      const nextFamily = model ? inferModelFamily(model) : null
      selectedModelRef.current = model
      setSelectedModelState(model)
      setSelectedModelOptions(current => {
        const nextOptions =
          currentFamily === nextFamily
            ? normalizeModelOptions(model, current)
            : getDefaultModelOptions(model)
        selectedModelOptionsRef.current = nextOptions
        if (model) {
          onSelectionChange?.(toSelectionConfig(model, nextOptions))
        }
        return nextOptions
      })
    },
    [locked, onSelectionBlocked, onSelectionChange, selectedModel]
  )

  const setSelectedModelOption = useCallback(
    (optionId: string, value: string) => {
      if (locked) return
      const nextOptions = { ...selectedModelOptionsRef.current, [optionId]: value }
      const currentModel = selectedModelRef.current
      selectedModelOptionsRef.current = nextOptions
      setSelectedModelOptions(nextOptions)
      if (currentModel) {
        onSelectionChange?.(toSelectionConfig(currentModel, nextOptions))
      } else {
        onSelectionChange?.(toDefaultModelSelectionConfig(nextOptions))
      }
    },
    [locked, onSelectionChange]
  )

  const getSelectedModel = useCallback(() => selectedModelRef.current, [])
  const getSelectedModelOptions = useCallback(() => selectedModelOptionsRef.current, [])

  return {
    models,
    selectedModel,
    selectedModelOptions,
    isSelectionReady,
    setSelectedModel,
    setSelectedModelOption,
    getSelectedModel,
    getSelectedModelOptions,
    isLoading,
    error,
  }
}
