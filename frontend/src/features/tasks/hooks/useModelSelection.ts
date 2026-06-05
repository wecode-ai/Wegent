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
import { modelApis, UnifiedModel, ModelTypeEnum, ModelCategoryType } from '@/apis/models'
import { useTranslation } from '@/hooks/useTranslation'
import {
  isPredefinedModel,
  getModelFromConfig,
  getModelNamespaceFromConfig,
  getModelTypeFromConfig,
  getAllowedModelsFromConfig,
} from '@/features/settings/services/bots'
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

// Re-export ModelCategoryType from @/apis/models for convenience
export type { ModelCategoryType } from '@/apis/models'

/** Model type for component props (extended with type information) */
export interface Model {
  name: string
  provider: string
  modelId: string
  displayName?: string | null
  type?: ModelTypeEnum
  region?: ModelRegion
  isAdvanced?: boolean
  namespace?: string
  modelGroup?: string | null
  modelSubGroup?: string | null
  config?: Record<string, unknown>
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
  /** Initial force override value when restoring a persisted non-task selection */
  initialForceOverride?: boolean
  /** Currently selected team with bot details */
  selectedTeam: TeamWithBotDetails | null
  /** Whether the selector is disabled (e.g., viewing existing task) */
  disabled?: boolean
  /** Model category type to filter models (default: 'llm') */
  modelCategoryType?: ModelCategoryType
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
  hasAdvancedModels: boolean
  boundDefaultModel: Model | null

  // Actions
  selectModel: (model: Model | null) => void
  selectModelByKey: (key: string) => void
  selectDefaultModel: () => void
  setForceOverride: (value: boolean) => void
  showAdvancedModels: boolean
  setShowAdvancedModels: (value: boolean) => void
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
export function unifiedToModel(unified: UnifiedModel): Model {
  return {
    name: unified.name,
    provider: unified.provider || 'claude',
    modelId: unified.modelId || '',
    displayName: unified.displayName,
    type: unified.type,
    isAdvanced: unified.isAdvanced ?? false,
    namespace: unified.namespace,
    modelGroup: unified.modelGroup,
    modelSubGroup: unified.modelSubGroup,
    config: unified.config,
  }
}

/** Get display text for a model: displayName or name */
function getModelDisplayTextHelper(model: Model): string {
  return model.displayName || model.name
}

function modelMatchesConfiguredRef(
  model: Model,
  modelName: string,
  modelType?: ModelTypeEnum,
  modelNamespace?: string
): boolean {
  const nameMatches = model.name === modelName || model.displayName === modelName
  if (!nameMatches) return false
  if (modelType && model.type !== modelType) return false
  if (modelNamespace && modelNamespace !== 'default' && model.namespace !== modelNamespace) {
    return false
  }
  return true
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
  modelCategoryType = 'llm',
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
  const [showAdvancedModels, setShowAdvancedModelsState] = useState(false)

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

  /** Get allowed_models whitelist from the first bot's agent_config */
  const allowedModels = useMemo(() => {
    const firstBot = selectedTeam?.bots?.[0]?.bot
    if (!firstBot?.agent_config) return []
    return getAllowedModelsFromConfig(firstBot.agent_config as Record<string, unknown>)
  }, [selectedTeam])

  const boundDefaultModel = useMemo((): Model | null => {
    const configuredModels = (selectedTeam?.bots ?? [])
      .map(botInfo => botInfo.bot?.agent_config as Record<string, unknown> | undefined)
      .filter((config): config is Record<string, unknown> => Boolean(config))
      .map(config => {
        const modelName = getModelFromConfig(config)
        if (!modelName) return null
        return models.find(model =>
          modelMatchesConfiguredRef(
            model,
            modelName,
            getModelTypeFromConfig(config),
            getModelNamespaceFromConfig(config)
          )
        )
      })
      .filter((model): model is Model => Boolean(model))

    const uniqueKeys = new Set(configuredModels.map(model => `${model.name}:${model.type || ''}`))
    if (uniqueKeys.size !== 1) {
      return null
    }

    return configuredModels[0] ?? null
  }, [selectedTeam?.bots, models])

  /**
   * Models that are valid for the current team.
   * This intentionally ignores showAdvancedModels: advanced visibility is a UI filter,
   * not a compatibility rule for persisted or already-selected models.
   */
  const selectableModels = useMemo(() => {
    let result = models
    if (compatibleProvider) {
      result = result.filter(model => model.provider === compatibleProvider)
    }
    // Apply allowed_models whitelist filter if configured
    if (allowedModels.length > 0) {
      const allowedNames = new Set(allowedModels.map(m => m.name))
      result = result.filter(m => allowedNames.has(m.name))
    }
    return result.slice().sort((a, b) => {
      const displayA = getModelDisplayTextHelper(a).toLowerCase()
      const displayB = getModelDisplayTextHelper(b).toLowerCase()
      return displayA.localeCompare(displayB)
    })
  }, [models, compatibleProvider, allowedModels])

  /** Check if there are any advanced models (after provider filtering) */
  const hasAdvancedModels = useMemo(() => {
    return selectableModels.some(model => model.isAdvanced === true)
  }, [selectableModels])

  /** Filter models by advanced visibility for dropdown display */
  const filteredModels = useMemo(() => {
    if (showAdvancedModels) {
      return selectableModels
    }
    return selectableModels.filter(model => !model.isAdvanced)
  }, [selectableModels, showAdvancedModels])

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
        const foundModel = selectableModels.find(model =>
          modelMatchesConfiguredRef(
            model,
            bindModel,
            getModelTypeFromConfig(botConfig),
            getModelNamespaceFromConfig(botConfig)
          )
        )
        return foundModel || null
      }
    }
    return null
  }, [selectedTeam?.bots, selectableModels])

  // -------------------------------------------------------------------------
  // Model Fetching
  // -------------------------------------------------------------------------
  const fetchModels = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      // Include config for image/video models to get type-specific config (imageConfig/videoConfig)
      const shouldIncludeConfig = modelCategoryType === 'image' || modelCategoryType === 'video'
      const response = await modelApis.getUnifiedModels(
        undefined,
        shouldIncludeConfig,
        'all',
        undefined,
        modelCategoryType
      )
      const modelList = (response.data || []).map(unifiedToModel)
      setModels(modelList)
    } catch (err) {
      console.error('Failed to fetch models:', err)
      setError(t('common:models.errors.load_models_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [t, modelCategoryType])

  // Load models on mount
  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // -------------------------------------------------------------------------
  // Model Selection Logic (Simplified)
  // Priority: 1. taskModelId (from API) -> 2. global preference -> 3. team's bind_model -> 4. default
  // -------------------------------------------------------------------------
  useEffect(() => {
    const currentTeamId = selectedTeam?.id ?? null
    const teamChanged = prevTeamIdRef.current !== null && prevTeamIdRef.current !== currentTeamId
    const taskChanged =
      hasInitializedRef.current &&
      prevTaskIdRef.current !== taskId &&
      (typeof prevTaskIdRef.current === 'number' || typeof taskId === 'number')

    prevTeamIdRef.current = currentTeamId
    prevTaskIdRef.current = taskId

    // Skip if no models loaded yet
    if (models.length === 0) {
      return
    }

    // Case 1: Initial load or team/task changed - restore model
    if (!hasInitializedRef.current || teamChanged || taskChanged) {
      isRestoringRef.current = true
      let restoredModel: Model | null = null
      let restoredForceOverride: boolean | undefined

      // Priority 1: Use taskModelId from API (if exists and not default)
      // Search in ALL models, not just filtered ones, since task already has a recorded model
      if (taskModelId && taskModelId !== DEFAULT_MODEL_NAME) {
        const foundModel = models.find(m => m.name === taskModelId || m.displayName === taskModelId)
        if (foundModel) {
          restoredModel = foundModel
          restoredForceOverride = true
        }
      }

      // Priority 2: Use global preference (for new chat only, i.e. no taskId)
      // NOTE: Must search in selectableModels to ensure model is compatible with current team's agent_type
      // while still allowing persisted advanced models even when they are hidden from the dropdown.
      if (!restoredModel && teamId && !taskId) {
        const preference = getGlobalModelPreference(teamId)
        if (preference && preference.modelName !== DEFAULT_MODEL_NAME) {
          const foundModel = selectableModels.find(m => {
            if (preference.modelType) {
              return m.name === preference.modelName && m.type === preference.modelType
            }
            return m.name === preference.modelName
          })
          if (foundModel) {
            restoredModel = foundModel
            restoredForceOverride = true
          }
        }
      }

      // Priority 3: Use team's bot bind_model as fallback
      if (!restoredModel && !taskModelId) {
        const teamDefaultModel = getTeamDefaultModel()
        if (teamDefaultModel) {
          restoredModel = teamDefaultModel
          restoredForceOverride = false
        }
      }

      // Priority 4: Use default if showDefaultOption and no model found
      if (!restoredModel && showDefaultOption) {
        restoredModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' }
        restoredForceOverride = false
      }

      if (restoredModel) {
        setSelectedModel(restoredModel)
        if (restoredModel.isAdvanced) {
          setShowAdvancedModelsState(true)
        }
        if (restoredModel.name === DEFAULT_MODEL_NAME) {
          setForceOverrideState(false)
        } else if (restoredForceOverride !== undefined) {
          setForceOverrideState(restoredForceOverride)
        } else {
          setForceOverrideState(true)
        }
      } else if (teamChanged) {
        // Clear selection on team change if no model found
        setSelectedModel(null)
        setForceOverrideState(false)
      }

      hasInitializedRef.current = true
      setTimeout(() => {
        isRestoringRef.current = false
      }, 100)
      return
    }

    // Case 2: Model list changed - check compatibility
    if (selectedModel && selectedModel.name !== DEFAULT_MODEL_NAME) {
      const isStillCompatible = selectableModels.some(m => {
        if (selectedModel.type) {
          return m.name === selectedModel.name && m.type === selectedModel.type
        }
        return m.name === selectedModel.name
      })
      if (!isStillCompatible) {
        setSelectedModel(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedTeam?.id,
    showDefaultOption,
    models,
    selectableModels,
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
    saveGlobalModelPreference(teamId, preference)
  }, [selectedModel, forceOverride, teamId])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Select a model directly */
  const selectModel = useCallback((model: Model | null) => {
    setSelectedModel(model)
    if (model?.isAdvanced) {
      setShowAdvancedModelsState(true)
    }
    setForceOverrideState(Boolean(model && model.name !== DEFAULT_MODEL_NAME))
  }, [])

  /** Select model by key (format: "modelName:modelType") */
  const selectModelByKey = useCallback(
    (key: string) => {
      if (key === DEFAULT_MODEL_NAME) {
        const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' }
        setSelectedModel(defaultModel)
        setForceOverrideState(false)
        return
      }

      const [modelName, modelType] = key.split(':')
      const model = filteredModels.find(m => m.name === modelName && m.type === modelType)
      if (model) {
        setSelectedModel(model)
        if (model.isAdvanced) {
          setShowAdvancedModelsState(true)
        }
        setForceOverrideState(true)
      }
    },
    [filteredModels]
  )

  /** Select default model */
  const selectDefaultModel = useCallback(() => {
    const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' }
    setSelectedModel(defaultModel)
    if (boundDefaultModel?.isAdvanced) {
      setShowAdvancedModelsState(true)
    }
    setForceOverrideState(false)
  }, [boundDefaultModel?.isAdvanced])

  /** Set force override flag */
  const setForceOverride = useCallback((value: boolean) => {
    setForceOverrideState(value)
  }, [])

  /** Set show advanced models flag */
  const setShowAdvancedModels = useCallback((value: boolean) => {
    setShowAdvancedModelsState(value)
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
    return getModelDisplayTextHelper(selectedModel)
  }, [selectedModel, isLoading, isModelRequired, getBoundModelDisplayNames, t])

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
    hasAdvancedModels,
    boundDefaultModel,

    // Actions
    selectModel,
    selectModelByKey,
    selectDefaultModel,
    setForceOverride,
    showAdvancedModels,
    setShowAdvancedModels,
    refreshModels: fetchModels,

    // Display helpers
    getDisplayText,
    getBoundModelDisplayNames,
    getModelKey,
    getModelDisplayText,
  }
}

export default useModelSelection
