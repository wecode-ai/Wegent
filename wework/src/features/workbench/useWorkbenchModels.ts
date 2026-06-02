import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getDefaultModelOptions,
  inferModelFamily,
  isSupportedModelFamily,
  normalizeModelOptions,
} from '@/lib/model-ui'
import type {
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
  selectionReady?: boolean
  onSelectionChange?: (selection: ModelSelectionConfig) => void
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

function toSelectionConfig(
  model: UnifiedModel,
  options: ModelOptions
): ModelSelectionConfig {
  return {
    modelName: model.name,
    modelType: model.type,
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

export function useWorkbenchModels({
  api,
  locked,
  selectionConfig,
  selectionReady = true,
  onSelectionChange,
}: UseWorkbenchModelsOptions) {
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModel, setSelectedModelState] = useState<UnifiedModel | null>(null)
  const [selectedModelOptions, setSelectedModelOptions] = useState<ModelOptions>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [restoredSelectionKey, setRestoredSelectionKey] = useState<string | null>(null)
  const selectionKey = useMemo(
    () => getSelectionKey(models, selectionConfig),
    [models, selectionConfig],
  )
  const selectionMatchesConfig =
    Boolean(
      selectionConfig?.modelName &&
        selectedModel &&
        selectedModel.name === selectionConfig.modelName &&
        (!selectionConfig.modelType || selectedModel.type === selectionConfig.modelType)
    )
  const isSelectionReady = useMemo(
    () =>
      selectionReady &&
      !isLoading &&
      (restoredSelectionKey === selectionKey || selectionMatchesConfig),
    [
      isLoading,
      restoredSelectionKey,
      selectionMatchesConfig,
      selectionKey,
      selectionReady,
    ],
  )

  const restoreSelection = useCallback(
    (
      availableModels: UnifiedModel[],
      nextSelectionConfig?: ModelSelectionConfig | null
    ) => {
      const model = findConfiguredModel(availableModels, nextSelectionConfig)
      const nextOptions = model
        ? normalizeModelOptions(model, nextSelectionConfig?.options ?? {})
        : {}
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
          setModels(filtered)
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
        restoreSelection(models, selectionConfig)
        setRestoredSelectionKey(selectionKey)
      }
    }

    syncSelection()
    return () => {
      cancelled = true
    }
  }, [models, restoreSelection, selectionConfig, selectionKey, selectionReady])

  const setSelectedModel = useCallback(
    (model: UnifiedModel | null) => {
      if (locked) return
      const currentFamily = selectedModel ? inferModelFamily(selectedModel) : null
      const nextFamily = model ? inferModelFamily(model) : null
      setSelectedModelState(model)
      setSelectedModelOptions(current => {
        const nextOptions =
          currentFamily === nextFamily
            ? normalizeModelOptions(model, current)
            : getDefaultModelOptions(model)
        if (model) {
          onSelectionChange?.(toSelectionConfig(model, nextOptions))
        }
        return nextOptions
      })
    },
    [locked, onSelectionChange, selectedModel]
  )

  const setSelectedModelOption = useCallback(
    (optionId: string, value: string) => {
      if (locked) return
      setSelectedModelOptions(current => {
        const nextOptions = { ...current, [optionId]: value }
        if (selectedModel) {
          onSelectionChange?.(toSelectionConfig(selectedModel, nextOptions))
        }
        return nextOptions
      })
    },
    [locked, onSelectionChange, selectedModel]
  )

  return {
    models,
    selectedModel,
    selectedModelOptions,
    isSelectionReady,
    setSelectedModel,
    setSelectedModelOption,
    isLoading,
    error,
  }
}
