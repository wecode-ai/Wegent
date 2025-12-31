// SPDX-FileCopyrightText: 2025 WeCode, Inc.
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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { modelApis, UnifiedModel, ModelTypeEnum } from '@/apis/models';
import { useTranslation } from '@/hooks/useTranslation';
import { isPredefinedModel, getModelFromConfig } from '@/features/settings/services/bots';
import {
  saveGlobalModelPreference,
  saveSessionModelPreference,
  getSessionModelPreference,
  getGlobalModelPreference,
  type ModelPreference,
} from '@/utils/modelPreferences';
import type { Team, BotSummary } from '@/types/api';

// ============================================================================
// Types
// ============================================================================

/** Region type for model deployment location */
export type ModelRegion = 'domestic' | 'overseas' | undefined;

/** Model type for component props (extended with type information) */
export interface Model {
  name: string;
  provider: string;
  modelId: string;
  displayName?: string | null;
  type?: ModelTypeEnum;
  region?: ModelRegion;
}

/** Special constant for default model option */
export const DEFAULT_MODEL_NAME = '__default__';

/** Extended Team type with bot details */
export interface TeamWithBotDetails extends Team {
  bots: Array<{
    bot_id: number;
    bot_prompt: string;
    role?: string;
    bot?: BotSummary;
  }>;
}

/** Options for useModelSelection hook */
export interface UseModelSelectionOptions {
  /** Current team ID for model preference storage */
  teamId: number | null;
  /** Current task ID for session-level model preference storage (null for new chat) */
  taskId: number | null;
  /** Task's model_id from backend - used as fallback when no session preference exists */
  taskModelId?: string | null;
  /** Currently selected team with bot details */
  selectedTeam: TeamWithBotDetails | null;
  /** Whether the selector is disabled (e.g., viewing existing task) */
  disabled?: boolean;
}

/** Return type for useModelSelection hook */
export interface UseModelSelectionReturn {
  // State
  selectedModel: Model | null;
  forceOverride: boolean;
  models: Model[];
  filteredModels: Model[];
  isLoading: boolean;
  error: string | null;

  // Derived state
  showDefaultOption: boolean;
  isModelRequired: boolean;
  isMixedTeam: boolean;
  compatibleProvider: string | null;

  // Actions
  selectModel: (model: Model | null) => void;
  selectModelByKey: (key: string) => void;
  selectDefaultModel: () => void;
  setForceOverride: (value: boolean) => void;
  refreshModels: () => Promise<void>;

  // Display helpers
  getDisplayText: () => string;
  getBoundModelDisplayNames: () => string[];
  getModelKey: (model: Model) => string;
  getModelDisplayText: (model: Model) => string;
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
  };
}

/** Get display text for a model: displayName or name */
function getModelDisplayTextHelper(model: Model): string {
  return model.displayName || model.name;
}

/** Check if all bots in a team have predefined models */
export function allBotsHavePredefinedModel(team: TeamWithBotDetails | null): boolean {
  if (!team || !team.bots || team.bots.length === 0) {
    return false;
  }

  return team.bots.every(botInfo => {
    const bot = botInfo.bot;
    if (!bot) return false;
    if (!bot.agent_config) return false;
    return isPredefinedModel(bot.agent_config as Record<string, unknown>);
  });
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
  const { t } = useTranslation();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [forceOverride, setForceOverrideState] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Refs for tracking state changes
  // -------------------------------------------------------------------------
  const prevTeamIdRef = useRef<number | null>(null);
  const prevTaskIdRef = useRef<number | null | undefined>(undefined);
  const hasInitializedRef = useRef(false);
  const userSelectedModelRef = useRef<Model | null>(null);
  const isTaskSwitchingRef = useRef(false);
  const userHasSelectedInSessionRef = useRef(false);

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------

  /** Use backend-calculated is_mix_team flag */
  const isMixedTeam = selectedTeam?.is_mix_team ?? false;

  /** Check if all bots have predefined models (show "Default" option) */
  const showDefaultOption = useMemo(() => {
    return allBotsHavePredefinedModel(selectedTeam);
  }, [selectedTeam]);

  /** Get compatible provider based on team agent_type */
  const compatibleProvider = useMemo((): string | null => {
    if (!selectedTeam?.agent_type) return null;
    const agentType = selectedTeam.agent_type.toLowerCase();
    if (agentType === 'agno') return 'openai';
    if (agentType === 'claude' || agentType === 'claudecode') return 'claude';
    return null;
  }, [selectedTeam?.agent_type]);

  /** Filter models by compatible provider and sort by display name */
  const filteredModels = useMemo(() => {
    let result = models;
    if (compatibleProvider) {
      result = models.filter(model => model.provider === compatibleProvider);
    }
    return result.slice().sort((a, b) => {
      const displayA = getModelDisplayTextHelper(a).toLowerCase();
      const displayB = getModelDisplayTextHelper(b).toLowerCase();
      return displayA.localeCompare(displayB);
    });
  }, [models, compatibleProvider]);

  /** Check if model selection is required */
  const isModelRequired = !showDefaultOption && !selectedModel;

  // -------------------------------------------------------------------------
  // Model Fetching
  // -------------------------------------------------------------------------

  const fetchModels = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm');
      const modelList = (response.data || []).map(unifiedToModel);
      setModels(modelList);
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(t('common:models.errors.load_models_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // Load models on mount
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // -------------------------------------------------------------------------
  // Auto-enable force override when team has predefined models
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (showDefaultOption && !disabled) {
      setForceOverrideState(true);
    }
  }, [showDefaultOption, disabled]);

  // -------------------------------------------------------------------------
  // Model Selection Logic (Unified)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const currentTeamId = selectedTeam?.id ?? null;
    const teamChanged = prevTeamIdRef.current !== null && prevTeamIdRef.current !== currentTeamId;
    const isTaskCreation =
      (prevTaskIdRef.current === undefined || prevTaskIdRef.current === null) &&
      typeof taskId === 'number';
    const taskChanged =
      hasInitializedRef.current &&
      prevTaskIdRef.current !== taskId &&
      typeof prevTaskIdRef.current === 'number' &&
      typeof taskId === 'number';

    console.log('[useModelSelection] Init effect triggered', {
      currentTeamId,
      prevTeamId: prevTeamIdRef.current,
      teamChanged,
      teamId,
      taskId,
      prevTaskId: prevTaskIdRef.current,
      isTaskCreation,
      taskChanged,
      hasInitialized: hasInitializedRef.current,
      selectedModel: selectedModel?.name,
      showDefaultOption,
      filteredModelsCount: filteredModels.length,
      disabled,
    });

    prevTeamIdRef.current = currentTeamId;
    prevTaskIdRef.current = taskId;

    // Case 1: Team changed - re-validate model selection
    if (teamChanged) {
      console.log('[useModelSelection] Case 1: Team changed', { taskId, hasTaskId: !!taskId });

      if (taskId) {
        console.log('[useModelSelection] Skipping team change handling: taskId exists');
        userSelectedModelRef.current = null;
        return;
      }

      userSelectedModelRef.current = null;

      if (showDefaultOption) {
        console.log('[useModelSelection] Setting to default (team has predefined models)');
        setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
        setForceOverrideState(false);
      } else if (selectedModel && selectedModel.name !== DEFAULT_MODEL_NAME) {
        const isStillCompatible = filteredModels.some(
          m => m.name === selectedModel.name && m.type === selectedModel.type
        );
        if (!isStillCompatible) {
          console.log('[useModelSelection] Current model not compatible, clearing');
          setSelectedModel(null);
        }
      } else {
        console.log('[useModelSelection] Clearing selection for non-default team');
        setSelectedModel(null);
      }
      return;
    }

    // Case 2: Task changed - restore from session preference or taskModelId
    if (taskChanged && taskId && teamId && filteredModels.length > 0 && !showDefaultOption) {
      console.log('[useModelSelection] Case 2: Task changed, restoring from session preference', {
        taskModelId,
      });
      isTaskSwitchingRef.current = true;

      const preference = getSessionModelPreference(taskId, teamId);
      console.log('[useModelSelection] Task switch preference', {
        teamId,
        taskId,
        preference,
        taskModelId,
      });

      if (preference && preference.modelName !== DEFAULT_MODEL_NAME) {
        const foundModel = filteredModels.find(m => {
          if (preference.modelType) {
            return m.name === preference.modelName && m.type === preference.modelType;
          }
          return m.name === preference.modelName;
        });
        if (foundModel) {
          console.log(
            '[useModelSelection] Restored model from session preference:',
            foundModel.name
          );
          setSelectedModel(foundModel);
          setForceOverrideState(preference.forceOverride);
          userSelectedModelRef.current = foundModel;
          // Mark as user selected since we restored from session preference
          userHasSelectedInSessionRef.current = true;
          setTimeout(() => {
            isTaskSwitchingRef.current = false;
          }, 100);
          return;
        }
      }

      if (taskModelId && taskModelId !== DEFAULT_MODEL_NAME) {
        // Match by name or displayName since taskModelId could be either
        const foundModel = filteredModels.find(
          m => m.name === taskModelId || m.displayName === taskModelId
        );
        if (foundModel) {
          console.log('[useModelSelection] Restored model from taskModelId:', foundModel.name);
          setSelectedModel(foundModel);
          setForceOverrideState(true);
          userSelectedModelRef.current = foundModel;
          // Mark as user selected since we restored from taskModelId
          userHasSelectedInSessionRef.current = true;
          setTimeout(() => {
            isTaskSwitchingRef.current = false;
          }, 100);
          return;
        }
      }

      isTaskSwitchingRef.current = false;
    }

    // Case 3: Initial load - restore from localStorage or set default
    if (!hasInitializedRef.current && filteredModels.length > 0) {
      console.log('[useModelSelection] Case 3: Initial load', {
        isTaskCreation,
        taskId,
        selectedModel: selectedModel?.name,
      });
      hasInitializedRef.current = true;

      if (showDefaultOption) {
        if (!selectedModel || selectedModel.name !== DEFAULT_MODEL_NAME) {
          console.log(
            '[useModelSelection] Setting to default (initial, team has predefined models)'
          );
          setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
        }
        return;
      }

      if (taskId && teamId) {
        const sessionPreference = getSessionModelPreference(taskId, teamId);
        console.log('[useModelSelection] Task exists, checking session preference', {
          teamId,
          taskId,
          sessionPreference,
          taskModelId,
        });

        if (sessionPreference && sessionPreference.modelName !== DEFAULT_MODEL_NAME) {
          const foundModel = filteredModels.find(m => {
            if (sessionPreference.modelType) {
              return (
                m.name === sessionPreference.modelName && m.type === sessionPreference.modelType
              );
            }
            return m.name === sessionPreference.modelName;
          });
          if (foundModel) {
            console.log(
              '[useModelSelection] Restored model from session preference:',
              foundModel.name
            );
            isTaskSwitchingRef.current = true;
            setTimeout(() => {
              isTaskSwitchingRef.current = false;
            }, 100);
            setSelectedModel(foundModel);
            setForceOverrideState(sessionPreference.forceOverride);
            userSelectedModelRef.current = foundModel;
            // Mark as user selected since we restored from session preference
            userHasSelectedInSessionRef.current = true;
            return;
          }
        }

        if (taskModelId && taskModelId !== DEFAULT_MODEL_NAME) {
          // Match by name or displayName since taskModelId could be either
          const foundModel = filteredModels.find(
            m => m.name === taskModelId || m.displayName === taskModelId
          );
          if (foundModel) {
            console.log('[useModelSelection] Restored model from taskModelId:', foundModel.name);
            isTaskSwitchingRef.current = true;
            setTimeout(() => {
              isTaskSwitchingRef.current = false;
            }, 100);
            setSelectedModel(foundModel);
            setForceOverrideState(true);
            userSelectedModelRef.current = foundModel;
            // Mark as user selected since we restored from taskModelId
            userHasSelectedInSessionRef.current = true;
            return;
          }
        }

        // Fallback: try to get default model from team's bot bind_model
        if (selectedTeam?.bots && selectedTeam.bots.length > 0) {
          const firstBot = selectedTeam.bots[0];
          const botConfig = firstBot.bot?.agent_config as Record<string, unknown> | undefined;
          if (botConfig) {
            const bindModel = getModelFromConfig(botConfig);
            if (bindModel) {
              // Match by name or displayName since bind_model could be either
              const foundModel = filteredModels.find(
                m => m.name === bindModel || m.displayName === bindModel
              );
              if (foundModel) {
                console.log(
                  '[useModelSelection] Restored model from team bot bind_model:',
                  foundModel.name
                );
                isTaskSwitchingRef.current = true;
                setTimeout(() => {
                  isTaskSwitchingRef.current = false;
                }, 100);
                setSelectedModel(foundModel);
                setForceOverrideState(true);
                userSelectedModelRef.current = foundModel;
                userHasSelectedInSessionRef.current = true;
                return;
              }
            }
          }
        }

        console.log(
          '[useModelSelection] No session preference, no taskModelId, and no team bot bind_model'
        );
        return;
      }

      if (teamId && !taskId) {
        const preference = getGlobalModelPreference(teamId);
        console.log('[useModelSelection] New chat, restoring from global preference', {
          teamId,
          preference,
          currentModel: selectedModel?.name,
        });

        if (preference && preference.modelName !== DEFAULT_MODEL_NAME) {
          const foundModel = filteredModels.find(m => {
            if (preference.modelType) {
              return m.name === preference.modelName && m.type === preference.modelType;
            }
            return m.name === preference.modelName;
          });
          if (foundModel) {
            if (!selectedModel || selectedModel.name !== foundModel.name) {
              console.log(
                '[useModelSelection] Restored model from global preference:',
                foundModel.name
              );
              setSelectedModel(foundModel);
              setForceOverrideState(preference.forceOverride);
              userSelectedModelRef.current = foundModel;
            }
          } else {
            console.log('[useModelSelection] Preference model not found in filtered models');
          }
        }
      }
      return;
    }

    // Mark as initialized when disabled (already has a model from task)
    if (!hasInitializedRef.current && disabled && selectedModel) {
      console.log('[useModelSelection] Marking as initialized (disabled with model)');
      hasInitializedRef.current = true;
      return;
    }

    // Case 4: Preserve user's explicit selection
    if (
      hasInitializedRef.current &&
      userSelectedModelRef.current &&
      !teamChanged &&
      !taskChanged &&
      !isTaskCreation &&
      filteredModels.length > 0 &&
      !disabled
    ) {
      const userModel = userSelectedModelRef.current;
      const isUserModelValid =
        userModel.name === DEFAULT_MODEL_NAME ||
        filteredModels.some(m => {
          if (userModel.type) {
            return m.name === userModel.name && m.type === userModel.type;
          }
          return m.name === userModel.name;
        });

      if (isUserModelValid && selectedModel?.name !== userModel.name) {
        console.log('[useModelSelection] Case 4: Restoring user selection:', userModel.name);
        setSelectedModel(userModel);
        return;
      }
    }

    // Case 5: Model list changed - check compatibility
    if (
      hasInitializedRef.current &&
      selectedModel &&
      selectedModel.name !== DEFAULT_MODEL_NAME &&
      !isTaskCreation &&
      !disabled
    ) {
      const isStillCompatible = filteredModels.some(m => {
        if (selectedModel.type) {
          return m.name === selectedModel.name && m.type === selectedModel.type;
        }
        return m.name === selectedModel.name;
      });
      if (!isStillCompatible && filteredModels.length > 0) {
        console.log('[useModelSelection] Case 5: Model no longer compatible, clearing');
        setSelectedModel(null);
        userSelectedModelRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeam?.id, showDefaultOption, filteredModels, teamId, taskId, disabled]);

  // -------------------------------------------------------------------------
  // Save Model Preference
  // -------------------------------------------------------------------------
  useEffect(() => {
    console.log('[useModelSelection] Save effect triggered', {
      selectedModel: selectedModel?.name,
      selectedModelType: selectedModel?.type,
      teamId,
      taskId,
      forceOverride,
      isTaskSwitching: isTaskSwitchingRef.current,
      userHasSelectedInSession: userHasSelectedInSessionRef.current,
    });

    if (isTaskSwitchingRef.current) {
      console.log('[useModelSelection] Skipping save: task switching in progress');
      return;
    }

    if (!selectedModel || !teamId) {
      console.log('[useModelSelection] Skipping save: no model or teamId');
      return;
    }

    if (taskId && !userHasSelectedInSessionRef.current) {
      console.log(
        '[useModelSelection] Skipping save to session: user has not selected model in this session'
      );
      return;
    }

    const preference: ModelPreference = {
      modelName: selectedModel.name,
      modelType: selectedModel.type,
      forceOverride,
      updatedAt: Date.now(),
    };

    if (taskId) {
      console.log('[useModelSelection] Saving to session dimension', {
        taskId,
        teamId,
        preference,
      });
      saveSessionModelPreference(taskId, teamId, preference);
    } else {
      console.log('[useModelSelection] Saving to global dimension', { teamId, preference });
      saveGlobalModelPreference(teamId, preference);
    }
  }, [selectedModel, forceOverride, teamId, taskId]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Select a model directly */
  const selectModel = useCallback((model: Model | null) => {
    userHasSelectedInSessionRef.current = true;
    setSelectedModel(model);
    if (model) {
      userSelectedModelRef.current = model;
    }
  }, []);

  /** Select model by key (format: "modelName:modelType") */
  const selectModelByKey = useCallback(
    (key: string) => {
      userHasSelectedInSessionRef.current = true;

      if (key === DEFAULT_MODEL_NAME) {
        const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' };
        setSelectedModel(defaultModel);
        userSelectedModelRef.current = defaultModel;
        return;
      }

      const [modelName, modelType] = key.split(':');
      const model = filteredModels.find(m => m.name === modelName && m.type === modelType);
      if (model) {
        setSelectedModel(model);
        userSelectedModelRef.current = model;
      }
    },
    [filteredModels]
  );

  /** Select default model */
  const selectDefaultModel = useCallback(() => {
    userHasSelectedInSessionRef.current = true;
    const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' };
    setSelectedModel(defaultModel);
    userSelectedModelRef.current = defaultModel;
  }, []);

  /** Set force override flag */
  const setForceOverride = useCallback((value: boolean) => {
    setForceOverrideState(value);
  }, []);

  // -------------------------------------------------------------------------
  // Display Helpers
  // -------------------------------------------------------------------------

  /** Get unique key for model (name + type) */
  const getModelKey = useCallback((model: Model): string => {
    return `${model.name}:${model.type || ''}`;
  }, []);

  /** Get display text for a model */
  const getModelDisplayText = useCallback((model: Model): string => {
    return getModelDisplayTextHelper(model);
  }, []);

  /** Get bound model display names from team bots */
  const getBoundModelDisplayNames = useCallback((): string[] => {
    if (!selectedTeam?.bots || selectedTeam.bots.length === 0) {
      return [];
    }
    return selectedTeam.bots
      .map(botInfo => {
        const config = botInfo.bot?.agent_config;
        if (!config) return '';
        const modelName = getModelFromConfig(config as Record<string, unknown>);
        if (!modelName) return '';
        const foundModel = models.find(m => m.name === modelName);
        return foundModel?.displayName || modelName;
      })
      .filter(Boolean);
  }, [selectedTeam?.bots, models]);

  /** Get display text for trigger button */
  const getDisplayText = useCallback((): string => {
    if (!selectedModel) {
      if (isLoading) {
        return t('common:actions.loading');
      }
      if (isModelRequired) {
        return t('common:task_submit.model_required', '请选择模型');
      }
      return t('common:task_submit.select_model', '选择模型');
    }
    if (selectedModel.name === DEFAULT_MODEL_NAME) {
      const boundModelDisplayNames = getBoundModelDisplayNames();

      if (boundModelDisplayNames.length === 1) {
        return boundModelDisplayNames[0];
      } else if (boundModelDisplayNames.length > 1) {
        return `${boundModelDisplayNames[0]} +${boundModelDisplayNames.length - 1}`;
      }
      return t('common:task_submit.default_model', '默认');
    }
    const displayText = getModelDisplayTextHelper(selectedModel);
    if (forceOverride && !isMixedTeam) {
      return `${displayText}(${t('common:task_submit.override_short', '覆盖')})`;
    }
    return displayText;
  }, [
    selectedModel,
    isLoading,
    isModelRequired,
    forceOverride,
    isMixedTeam,
    getBoundModelDisplayNames,
    t,
  ]);

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
  };
}

export default useModelSelection;
