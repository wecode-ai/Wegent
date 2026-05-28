import { useCallback, useEffect, useState } from 'react'
import type { UnifiedModel, UnifiedModelListResponse } from '@/types/api'

interface WorkbenchModelApi {
  listModels: () => Promise<UnifiedModelListResponse>
}

interface UseWorkbenchModelsOptions {
  api: WorkbenchModelApi
  locked: boolean
}

function isClaudeModel(model: UnifiedModel): boolean {
  return [model.name, model.displayName, model.modelId, model.provider]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes('claude'))
}

export function useWorkbenchModels({ api, locked }: UseWorkbenchModelsOptions) {
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModel, setSelectedModelState] = useState<UnifiedModel | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadModels() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.listModels()
        if (!cancelled) {
          const filtered = response.data.filter(isClaudeModel)
          setModels(filtered)
          if (filtered.length > 0) {
            setSelectedModelState(filtered[0])
          }
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
  }, [api])

  const setSelectedModel = useCallback(
    (model: UnifiedModel | null) => {
      if (locked) return
      setSelectedModelState(model)
    },
    [locked]
  )

  return {
    models,
    selectedModel,
    setSelectedModel,
    isLoading,
    error,
  }
}
