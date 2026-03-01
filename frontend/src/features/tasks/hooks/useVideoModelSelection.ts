// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useVideoModelSelection Hook
 *
 * A hook for managing video model selection state.
 * Fetches video models from the API and provides selection functionality.
 * Uses the same Model type as regular model selection for consistency.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { modelApis, type VideoGenerationConfig } from '@/apis/models'
import type { Model } from './useModelSelection'

export interface UseVideoModelSelectionOptions {
  enabled?: boolean
}

export interface UseVideoModelSelectionReturn {
  videoModels: Model[]
  selectedModel: Model | null
  setSelectedModel: (model: Model) => void
  selectedResolution: string
  setSelectedResolution: (resolution: string) => void
  selectedRatio: string
  setSelectedRatio: (ratio: string) => void
  availableResolutions: string[]
  availableRatios: string[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

// Store video config separately since Model type doesn't have it
const videoConfigMap = new Map<string, VideoGenerationConfig>()

export function useVideoModelSelection(
  options: UseVideoModelSelectionOptions = {}
): UseVideoModelSelectionReturn {
  const { enabled = true } = options

  const [videoModels, setVideoModels] = useState<Model[]>([])
  const [selectedModel, setSelectedModelState] = useState<Model | null>(null)
  const [selectedResolution, setSelectedResolution] = useState<string>('1080p')
  const [selectedRatio, setSelectedRatio] = useState<string>('16:9')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load video models from API
  const loadVideoModels = useCallback(async () => {
    if (!enabled) return

    setIsLoading(true)
    setError(null)

    try {
      // Fetch models with modelCategoryType = 'video'
      const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'video')

      const models: Model[] = response.data.map(item => {
        // Store video config in map for later retrieval
        const videoConfig = (item.config as Record<string, unknown>)?.videoConfig as
          | VideoGenerationConfig
          | undefined
        if (videoConfig) {
          videoConfigMap.set(item.name, videoConfig)
        }

        return {
          name: item.name,
          displayName: item.displayName || undefined,
          provider: ((item.config as Record<string, unknown>)?.protocol as string) || 'seedance',
          modelId: item.name,
          type: item.type,
          namespace: item.namespace || 'default',
        }
      })

      setVideoModels(models)

      // Auto-select first model if none selected
      // Use functional update to avoid dependency on selectedModel
      setSelectedModelState(prev => {
        if (prev) return prev // Keep existing selection
        if (models.length === 0) return null

        const firstModel = models[0]
        // Apply model's default config from map
        const videoConfig = videoConfigMap.get(firstModel.name)
        if (videoConfig?.resolution) {
          setSelectedResolution(videoConfig.resolution)
        }
        if (videoConfig?.ratio) {
          setSelectedRatio(videoConfig.ratio)
        }
        return firstModel
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load video models')
    } finally {
      setIsLoading(false)
    }
  }, [enabled])

  // Load models on mount
  useEffect(() => {
    loadVideoModels()
  }, [loadVideoModels])

  // Available resolution options
  const availableResolutions = useMemo(() => {
    return ['480p', '720p', '1080p']
  }, [])

  // Available aspect ratio options
  const availableRatios = useMemo(() => {
    return ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']
  }, [])

  // Handle model selection
  const handleModelSelect = useCallback((model: Model) => {
    setSelectedModelState(model)

    // Apply model's default config if available from map
    const videoConfig = videoConfigMap.get(model.name)
    if (videoConfig?.resolution) {
      setSelectedResolution(videoConfig.resolution)
    }
    if (videoConfig?.ratio) {
      setSelectedRatio(videoConfig.ratio)
    }
  }, [])

  return {
    videoModels,
    selectedModel,
    setSelectedModel: handleModelSelect,
    selectedResolution,
    setSelectedResolution,
    selectedRatio,
    setSelectedRatio,
    availableResolutions,
    availableRatios,
    isLoading,
    error,
    refresh: loadVideoModels,
  }
}

export default useVideoModelSelection
