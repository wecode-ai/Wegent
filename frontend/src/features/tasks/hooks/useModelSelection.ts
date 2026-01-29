// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useModelSelection Hook
 *
 * Centralized hook for managing all model selection logic including:
 * - Model list fetching and filtering
 * - Model preference restoration (initial load, team switch, task switch)
 * - Model preference saving (global and session dimensions)
 * - Compatibility checking
 * - Display text generation
 *
 * This hook extracts business logic from ModelSelector component,
 * making it a pure UI component.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { modelApis, UnifiedModel, ModelTypeEnum } from '@/apis/models'
import { useTranslation } from '@/hooks/useTranslation'
import { isPredefinedModel, getModelFromConfig } from '@/features/settings/services/bots'
import { getCompatibleProviderFromAgentType } from '@/utils/modelCompatibility'
import {
  saveGlobalModelPreference,
  getGlobalModelPreference,
  type ModelPreference,
} from '@/utils/modelPreferences'
import type { Team, BotSummary } from '@/types/api'

// ============================================================================
// Types
// ============================================================================

/** Region type for model deployment location */
export type ModelRegion = 'domestic' | 'overseas' | undefined

/** Model type for component props (extended with type information) */
export interface Model {
  name: string
  provider: string
  modelId: string
  displayName?: string | null
  type?: ModelTypeEnum
  region?: ModelRegion
}

/** Special constant for default model option */
export const DEFAULT_MODEL_NAME = '__default__'

/** Extended Team type with bot details */
export interface TeamWithBotDetails extends Team {
  bots: Array<{
    bot_id: number
    bot_prompt: string
    role?: string
    bot?: BotSummary
  }>
}

/** Options for useModelSelection hook */
export interface UseModelSelectionOptions {
  /** Current team ID for model preference storage */
  teamId: number | null
  /** Current task ID for session-level model preference storage (null for new chat) */
  taskId: number | null
  /** Task's model_id from backend - used as fallback when no session preference exists */
  taskModelId?: string | null
  /** Currently selected team with bot details */
  selectedTeam: TeamWithBotDetails | null
  /** Whether the selector is disabled (e.g., viewing existing task) */
  disabled?: boolean
}

/** Return type for useModelSelection hook */
export interface UseModelSelectionReturn {
  // State
  selectedModel: Model | null
  forceOverride: boolean
  models: Model[]
  filteredModels: Model[]
  isLoading: boolean
  error: string | null

  // Derived state
  showDefaultOption: boolean
  isModelRequired: boolean
  isMixedTeam: boolean
  compatibleProvider: string | null

  // Actions
  selectModel: (model: Model | null) => void
  selectModelByKey: (key: string) => void
  selectDefaultModel: () => void
  setForceOverride: (value: boolean) => void
  refreshModels: () => Promise<void>

  // Display helpers
  getDisplayText: () => string
  getBoundModelDisplayNames: () => string[]
  getModelKey: (model: Model) => string
  getModelDisplayText: (model: Model) => string
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Convert UnifiedModel to Model */
function unifiedToModel(unified: UnifiedModel): Model {
  return {
    name: unified.name,
    provider: unified.provider || 'claude',
    modelId: unified.modelId || '',
    displayName: unified.displayName,
    type: unified.type,
  }
}

/** Get display text for a model: displayName or name */
function getModelDisplayTextHelper(model: Model): string {
  return model.displayName || model.name
}

/** Check if all bots in a team have predefined models */
export function allBotsHavePredefinedModel(team: TeamWithBotDetails | null): boolean {
  if (!team || !team.bots || team.bots.length === 0) {
    return false
  }

  return team.bots.every(botInfo => {
    const bot = botInfo.bot
    if (!bot) return false
    if (!bot.agent_config) return false
    return isPredefinedModel(bot.agent_config as Record<string, unknown>)
  })
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useModelSelection({
  teamId,
  taskId,
  taskModelId,
  selectedTeam,
  disabled = false,
}: UseModelSelectionOptions): UseModelSelectionReturn {
  const { t } = useTranslation()

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [forceOverride, setForceOverrideState] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // Refs for tracking state changes
  // -------------------------------------------------------------------------
  const prevTeamIdRef = useRef<number | null>(null)
  const prevTaskIdRef = useRef<number | null | undefined>(undefined)
  const hasInitializedRef = useRef(false)
  const isRestoringRef = useRef(false)

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------

  /** Use backend-calculated is_mix_team flag */
  const isMixedTeam = selectedTeam?.is_mix_team ?? false

  /** Check if all bots have predefined models (show "Default" option) */
  const showDefaultOption = useMemo(() => {
    return allBotsHavePredefinedModel(selectedTeam)
  }, [selectedTeam])

  /** Get compatible provider based on team agent_type */
  const compatibleProvider = useMemo((): string | null => {
    return getCompatibleProviderFromAgentType(selectedTeam?.agent_type)
  }, [selectedTeam?.agent_type])

  /** Filter models by compatible provider and sort by display name */
  const filteredModels = useMemo(() => {
    let result = models
    if (compatibleProvider) {
      result = models.filter(model => model.provider === compatibleProvider)
    }
    return result.slice().sort((a, b) => {
      const displayA = getModelDisplayTextHelper(a).toLowerCase()
      const displayB = getModelDisplayTextHelper(b).toLowerCase()
      return displayA.localeCompare(displayB)
    })
  }, [models, compatibleProvider])

  /** Check if model selection is required */
  const isModelRequired = !showDefaultOption && !selectedModel

  // -------------------------------------------------------------------------
  // Helper: Get default model from team's bot bind_model
  // -------------------------------------------------------------------------
  const getTeamDefaultModel = useCallback((): Model | null => {
    if (!selectedTeam?.bots || selectedTeam.bots.length === 0) {
      return null
    }
    const firstBot = selectedTeam.bots[0]
    const botConfig = firstBot.bot?.agent_config as Record<string, unknown> | undefined
    if (botConfig) {
      const bindModel = getModelFromConfig(botConfig)
      if (bindModel) {
        const foundModel = filteredModels.find(
          m => m.name === bindModel || m.displayName === bindModel
        )
        return foundModel || null
      }
    }
    return null
  }, [selectedTeam?.bots, filteredModels])

  // -------------------------------------------------------------------------
  // Model Fetching
  // -------------------------------------------------------------------------

  const fetchModels = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm')
      const modelList = (response.data || []).map(unifiedToModel)
      setModels(modelList)
    } catch (err) {
      console.error('Failed to fetch models:', err)
      setError(t('common:models.errors.load_models_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  // Load models on mount
  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // -------------------------------------------------------------------------
  // Auto-enable force override when team has predefined models
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (showDefaultOption && !disabled) {
      setForceOverrideState(true)
    }
  }, [showDefaultOption, disabled])

  // -------------------------------------------------------------------------
  // Model Selection Logic (Simplified)
  // Priority: 1. taskModelId (from API) -> 2. team's bind_model -> 3. global preference
  // -------------------------------------------------------------------------
  useEffect(() => {
    const currentTeamId = selectedTeam?.id ?? null
    const teamChanged = prevTeamIdRef.current !== null && prevTeamIdRef.current !== currentTeamId
    const taskChanged =
      hasInitializedRef.current &&
      prevTaskIdRef.current !== taskId &&
      (typeof prevTaskIdRef.current === 'number' || typeof taskId === 'number')

    console.log('[useModelSelection] Selection effect triggered', {
      currentTeamId,
      teamChanged,
      taskId,
      taskChanged,
      taskModelId,
      hasInitialized: hasInitializedRef.current,
      modelsCount: models.length,
      filteredModelsCount: filteredModels.length,
      showDefaultOption,
      currentSelectedModel: selectedModel?.name,
    })

    // Debug: Log all model names and displayNames
    if (models.length > 0 && taskModelId) {
      console.log('[useModelSelection] Looking for taskModelId:', taskModelId)
      console.log(
        '[useModelSelection] Available models:',
        models.map(m => ({
          name: m.name,
          displayName: m.displayName,
          provider: m.provider,
          type: m.type,
        }))
      )
    }

    prevTeamIdRef.current = currentTeamId
    prevTaskIdRef.current = taskId

    // Skip if no models loaded yet
    if (models.length === 0) {
      console.log('[useModelSelection] Skipping: no models loaded yet')
      return
    }

    // Case 1: Initial load or team/task changed - restore model
    if (!hasInitializedRef.current || teamChanged || taskChanged) {
      console.log('[useModelSelection] Case 1: Initial load or team/task changed', {
        hasInitialized: hasInitializedRef.current,
        teamChanged,
        taskChanged,
        taskId,
        taskModelId,
        showDefaultOption,
      })
      isRestoringRef.current = true
      let restoredModel: Model | null = null

      // Priority 1: Use taskModelId from API (if exists and not default)
      // Search in ALL models, not just filtered ones, since task already has a recorded model
      if (taskModelId && taskModelId !== DEFAULT_MODEL_NAME) {
        console.log('[useModelSelection] Priority 1: Searching for taskModelId in all models...')
        const foundModel = models.find(m => m.name === taskModelId || m.displayName === taskModelId)
        if (foundModel) {
          console.log('[useModelSelection] Priority 1: Found model by taskModelId:', {
            name: foundModel.name,
            displayName: foundModel.displayName,
            provider: foundModel.provider,
          })
          restoredModel = foundModel
        } else {
          console.log(
            '[useModelSelection] Priority 1: taskModelId NOT found in models:',
            taskModelId
          )
        }
      } else {
        console.log('[useModelSelection] Priority 1: Skipped (no taskModelId or is default)', {
          taskModelId,
        })
      }

      // Priority 2: Use global preference (for new chat only, i.e. no taskId)
      // NOTE: Must search in filteredModels to ensure model is compatible with current team's agent_type
      if (!restoredModel && teamId && !taskId) {
        console.log('[useModelSelection] Priority 2: Checking global preference (new chat)...')
        const preference = getGlobalModelPreference(teamId)
        console.log('[useModelSelection] Priority 2: Global preference:', preference)
        if (preference && preference.modelName !== DEFAULT_MODEL_NAME) {
          // Search in filteredModels (not models) to ensure compatibility with team's agent_type
          const foundModel = filteredModels.find(m => {
            if (preference.modelType) {
              return m.name === preference.modelName && m.type === preference.modelType
            }
            return m.name === preference.modelName
          })
          if (foundModel) {
            console.log('[useModelSelection] Priority 2: Using global preference:', foundModel.name)
            restoredModel = foundModel
            setForceOverrideState(preference.forceOverride)
          } else {
            console.log(
              '[useModelSelection] Priority 2: Global preference model not compatible with current team (not in filteredModels)',
              {
                preferenceName: preference.modelName,
                compatibleProvider,
                filteredModelsCount: filteredModels.length,
              }
            )
          }
        }
      }

      // Priority 3: Use team's bot bind_model as fallback
      if (!restoredModel && !taskModelId) {
        console.log('[useModelSelection] Priority 3: Checking team bind_model...')
        const teamDefaultModel = getTeamDefaultModel()
        if (teamDefaultModel) {
          console.log(
            '[useModelSelection] Priority 3: Using team bind_model:',
            teamDefaultModel.name
          )
          restoredModel = teamDefaultModel
        } else {
          console.log('[useModelSelection] Priority 3: No team bind_model found')
        }
      }

      // Priority 4: Use default if showDefaultOption and no model found
      if (!restoredModel && showDefaultOption) {
        console.log('[useModelSelection] Priority 4: Using default model (showDefaultOption=true)')
        restoredModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' }
        setForceOverrideState(false)
      }

      console.log('[useModelSelection] Final restoredModel:', restoredModel?.name ?? 'null')

      if (restoredModel) {
        setSelectedModel(restoredModel)
        if (restoredModel.name !== DEFAULT_MODEL_NAME) {
          setForceOverrideState(true)
        }
      } else if (teamChanged) {
        // Clear selection on team change if no model found
        console.log('[useModelSelection] Clearing selection (team changed, no model found)')
        setSelectedModel(null)
      }

      hasInitializedRef.current = true
      setTimeout(() => {
        isRestoringRef.current = false
      }, 100)
      return
    }

    // Case 2: Model list changed - check compatibility
    if (selectedModel && selectedModel.name !== DEFAULT_MODEL_NAME) {
      const isStillCompatible = filteredModels.some(m => {
        if (selectedModel.type) {
          return m.name === selectedModel.name && m.type === selectedModel.type
        }
        return m.name === selectedModel.name
      })
      if (!isStillCompatible) {
        console.log('[useModelSelection] Case 2: Model no longer compatible, clearing')
        setSelectedModel(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedTeam?.id,
    showDefaultOption,
    models,
    filteredModels,
    teamId,
    taskId,
    taskModelId,
    compatibleProvider,
  ])

  // -------------------------------------------------------------------------
  // Save Model Preference (Always save to global when user changes model)
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Skip during restore
    if (isRestoringRef.current) {
      return
    }

    if (!selectedModel || !teamId) {
      return
    }

    // Skip if not initialized (initial load)
    if (!hasInitializedRef.current) {
      return
    }

    const preference: ModelPreference = {
      modelName: selectedModel.name,
      modelType: selectedModel.type,
      forceOverride,
      updatedAt: Date.now(),
    }

    // Always save to global when model changes
    console.log('[useModelSelection] Saving to global', { teamId, preference })
    saveGlobalModelPreference(teamId, preference)
  }, [selectedModel, forceOverride, teamId])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Select a model directly */
  const selectModel = useCallback((model: Model | null) => {
    setSelectedModel(model)
  }, [])

  /** Select model by key (format: "modelName:modelType") */
  const selectModelByKey = useCallback(
    (key: string) => {
      if (key === DEFAULT_MODEL_NAME) {
        const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' }
        setSelectedModel(defaultModel)
        return
      }

      const [modelName, modelType] = key.split(':')
      const model = filteredModels.find(m => m.name === modelName && m.type === modelType)
      if (model) {
        setSelectedModel(model)
      }
    },
    [filteredModels]
  )

  /** Select default model */
  const selectDefaultModel = useCallback(() => {
    const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' }
    setSelectedModel(defaultModel)
  }, [])

  /** Set force override flag */
  const setForceOverride = useCallback((value: boolean) => {
    setForceOverrideState(value)
  }, [])

  // -------------------------------------------------------------------------
  // Display Helpers
  // -------------------------------------------------------------------------

  /** Get unique key for model (name + type) */
  const getModelKey = useCallback((model: Model): string => {
    return `${model.name}:${model.type || ''}`
  }, [])

  /** Get display text for a model */
  const getModelDisplayText = useCallback((model: Model): string => {
    return getModelDisplayTextHelper(model)
  }, [])

  /** Get bound model display names from team bots */
  const getBoundModelDisplayNames = useCallback((): string[] => {
    if (!selectedTeam?.bots || selectedTeam.bots.length === 0) {
      return []
    }
    return selectedTeam.bots
      .map(botInfo => {
        const config = botInfo.bot?.agent_config
        if (!config) return ''
        const modelName = getModelFromConfig(config as Record<string, unknown>)
        if (!modelName) return ''
        const foundModel = models.find(m => m.name === modelName)
        return foundModel?.displayName || modelName
      })
      .filter(Boolean)
  }, [selectedTeam?.bots, models])

  /** Get display text for trigger button */
  const getDisplayText = useCallback((): string => {
    if (!selectedModel) {
      if (isLoading) {
        return t('common:actions.loading')
      }
      if (isModelRequired) {
        return t('common:task_submit.model_required', '请选择模型')
      }
      return t('common:task_submit.select_model', '选择模型')
    }
    if (selectedModel.name === DEFAULT_MODEL_NAME) {
      const boundModelDisplayNames = getBoundModelDisplayNames()

      if (boundModelDisplayNames.length === 1) {
        return boundModelDisplayNames[0]
      } else if (boundModelDisplayNames.length > 1) {
        return `${boundModelDisplayNames[0]} +${boundModelDisplayNames.length - 1}`
      }
      return t('common:task_submit.default_model', '默认')
    }
    const displayText = getModelDisplayTextHelper(selectedModel)
    if (forceOverride && !isMixedTeam) {
      return `${displayText}(${t('common:task_submit.override_short', '覆盖')})`
    }
    return displayText
  }, [
    selectedModel,
    isLoading,
    isModelRequired,
    forceOverride,
    isMixedTeam,
    getBoundModelDisplayNames,
    t,
  ])

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  return {
    // State
    selectedModel,
    forceOverride,
    models,
    filteredModels,
    isLoading,
    error,

    // Derived state
    showDefaultOption,
    isModelRequired,
    isMixedTeam,
    compatibleProvider,

    // Actions
    selectModel,
    selectModelByKey,
    selectDefaultModel,
    setForceOverride,
    refreshModels: fetchModels,

    // Display helpers
    getDisplayText,
    getBoundModelDisplayNames,
    getModelKey,
    getModelDisplayText,
  }
}

export default useModelSelection
