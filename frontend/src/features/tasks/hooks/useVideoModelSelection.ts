// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useVideoModelSelection Hook
 *
 * A hook for managing video model selection state.
 * Fetches video models from the API and provides selection functionality.
 * Dynamically derives available options from model capabilities.
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
  selectedDuration: number
  setSelectedDuration: (duration: number) => void
  availableResolutions: string[]
  availableRatios: string[]
  availableDurations: number[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

// Default capabilities when model has none defined
const DEFAULT_RESOLUTIONS = ['480p', '720p', '1080p']
const DEFAULT_RATIOS = ['16:9', '9:16', '1:1']
const DEFAULT_DURATIONS = [5, 10]

// Store video config separately since Model type doesn't have it
const videoConfigMap = new Map<string, VideoGenerationConfig>()

export function useVideoModelSelection(
  options: UseVideoModelSelectionOptions = {}
): UseVideoModelSelectionReturn {
  const { enabled = true } = options

  const [videoModels, setVideoModels] = useState<Model[]>([])
  const [selectedModel, setSelectedModelState] = useState<Model | null>(null)
  const [selectedResolution, setSelectedResolution] = useState<string>('720p')
  const [selectedRatio, setSelectedRatio] = useState<string>('16:9')
  const [selectedDuration, setSelectedDuration] = useState<number>(5)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Apply default values from model config when model changes
  const applyModelDefaults = useCallback((model: Model) => {
    const videoConfig = videoConfigMap.get(model.name)
    const caps = videoConfig?.capabilities

    // Get available options from capabilities
    const resolutions = caps?.resolutions?.map(r => r.label) ?? DEFAULT_RESOLUTIONS
    const ratios = caps?.aspect_ratios?.map(r => r.value) ?? DEFAULT_RATIOS
    const durations = caps?.durations_sec ?? DEFAULT_DURATIONS

    // Reset resolution if not in new model's options
    setSelectedResolution(prev => {
      if (resolutions.includes(prev)) return prev
      return videoConfig?.resolution ?? resolutions[0] ?? '720p'
    })

    // Reset ratio if not in new model's options
    setSelectedRatio(prev => {
      if (ratios.includes(prev)) return prev
      return videoConfig?.ratio ?? ratios[0] ?? '16:9'
    })

    // Reset duration if not in new model's options
    setSelectedDuration(prev => {
      if (durations.includes(prev)) return prev
      return videoConfig?.duration ?? durations[0] ?? 5
    })
  }, [])

  // Load video models from API
  const loadVideoModels = useCallback(async () => {
    if (!enabled) return

    setIsLoading(true)
    setError(null)

    try {
      const response = await modelApis.getUnifiedModels(undefined, true, 'all', undefined, 'video')

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
      setSelectedModelState(prev => {
        if (prev) return prev
        if (models.length === 0) return null

        const firstModel = models[0]
        applyModelDefaults(firstModel)
        return firstModel
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load video models')
    } finally {
      setIsLoading(false)
    }
  }, [enabled, applyModelDefaults])

  // Load models on mount
  useEffect(() => {
    loadVideoModels()
  }, [loadVideoModels])

  // Available resolution options from selected model's capabilities
  const availableResolutions = useMemo(() => {
    if (!selectedModel) return DEFAULT_RESOLUTIONS
    const videoConfig = videoConfigMap.get(selectedModel.name)
    if (videoConfig?.capabilities?.resolutions) {
      return videoConfig.capabilities.resolutions.map(r => r.label)
    }
    return DEFAULT_RESOLUTIONS
  }, [selectedModel])

  // Available aspect ratio options from selected model's capabilities
  const availableRatios = useMemo(() => {
    if (!selectedModel) return DEFAULT_RATIOS
    const videoConfig = videoConfigMap.get(selectedModel.name)
    if (videoConfig?.capabilities?.aspect_ratios) {
      return videoConfig.capabilities.aspect_ratios.map(r => r.value)
    }
    return DEFAULT_RATIOS
  }, [selectedModel])

  // Available duration options from selected model's capabilities
  const availableDurations = useMemo(() => {
    if (!selectedModel) return DEFAULT_DURATIONS
    const videoConfig = videoConfigMap.get(selectedModel.name)
    if (videoConfig?.capabilities?.durations_sec) {
      return videoConfig.capabilities.durations_sec
    }
    return DEFAULT_DURATIONS
  }, [selectedModel])

  // Handle model selection
  const handleModelSelect = useCallback(
    (model: Model) => {
      setSelectedModelState(model)
      applyModelDefaults(model)
    },
    [applyModelDefaults]
  )

  return {
    videoModels,
    selectedModel,
    setSelectedModel: handleModelSelect,
    selectedResolution,
    setSelectedResolution,
    selectedRatio,
    setSelectedRatio,
    selectedDuration,
    setSelectedDuration,
    availableResolutions,
    availableRatios,
    availableDurations,
    isLoading,
    error,
    refresh: loadVideoModels,
  }
}

export default useVideoModelSelection
