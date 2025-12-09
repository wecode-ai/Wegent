// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { CpuChipIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Checkbox } from '@/components/ui/checkbox';
import { Team, BotSummary } from '@/types/api';
import { modelApis, UnifiedModel, ModelTypeEnum } from '@/apis/models';
import { useTranslation } from '@/hooks/useTranslation';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/utils';
import { paths } from '@/config/paths';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isPredefinedModel, getModelFromConfig } from '@/features/settings/services/bots';

// Model type for component props (extended with type information)
export interface Model {
  name: string;
  provider: string; // 'openai' | 'claude'
  modelId: string;
  displayName?: string | null; // Human-readable display name
  type?: ModelTypeEnum; // 'public' | 'user' - identifies model source
}

// Special constant for default model option
export const DEFAULT_MODEL_NAME = '__default__';

// Extended Team type with bot details (using BotSummary for agent_config)
interface TeamWithBotDetails extends Team {
  bots: Array<{
    bot_id: number;
    bot_prompt: string;
    role?: string;
    bot?: BotSummary;
  }>;
}

interface ModelSelectorProps {
  selectedModel: Model | null;
  setSelectedModel: (model: Model | null) => void;
  forceOverride: boolean;
  setForceOverride: (force: boolean) => void;
  selectedTeam: TeamWithBotDetails | null;
  disabled: boolean;
  isLoading?: boolean;
}

const LAST_SELECTED_MODEL_KEY = 'last_selected_model_id';
const LAST_SELECTED_MODEL_TYPE_KEY = 'last_selected_model_type';

// Helper function to convert UnifiedModel to Model
function unifiedToModel(unified: UnifiedModel): Model {
  return {
    name: unified.name,
    provider: unified.provider || 'claude',
    modelId: unified.modelId || '',
    displayName: unified.displayName,
    type: unified.type,
  };
}

// Helper function to get display text for a model: displayName(modelId) or name(modelId)
function getModelDisplayText(model: Model): string {
  return model.displayName ? `${model.displayName}(${model.name})` : model.name;
}

// Helper function to check if all bots in a team have predefined models
// Exported for use in ChatArea to determine if model selection is required
export function allBotsHavePredefinedModel(team: TeamWithBotDetails | null): boolean {
  if (!team || !team.bots || team.bots.length === 0) {
    return false;
  }

  return team.bots.every(botInfo => {
    const bot = botInfo.bot;
    // If bot summary is not available, we can't determine if it has a predefined model
    if (!bot) {
      return false;
    }
    // If agent_config is not available or empty, it's not a predefined model
    if (!bot.agent_config) {
      return false;
    }
    return isPredefinedModel(bot.agent_config as Record<string, unknown>);
  });
}

export default function ModelSelector({
  selectedModel,
  setSelectedModel,
  forceOverride,
  setForceOverride,
  selectedTeam,
  disabled,
  isLoading: externalLoading,
}: ModelSelectorProps) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');

  // Use backend-calculated is_mix_team flag
  const isMixedTeam = selectedTeam?.is_mix_team ?? false;

  // Check if all bots have predefined models (show "Default" option)
  const showDefaultOption = useMemo(() => {
    return allBotsHavePredefinedModel(selectedTeam);
  }, [selectedTeam]);

  // Auto-enable force override when team has predefined models (showDefaultOption is true)
  // This ensures that when a team already has bound models, the override option is checked by default
  useEffect(() => {
    if (showDefaultOption && !disabled) {
      setForceOverride(true);
    }
  }, [showDefaultOption, setForceOverride, disabled]);

  // Get compatible provider based on team agent_type
  // agent_type 'agno' -> provider 'openai', agent_type 'claude'/'claudecode' -> provider 'claude'
  const compatibleProvider = useMemo((): string | null => {
    if (!selectedTeam?.agent_type) return null;
    const agentType = selectedTeam.agent_type.toLowerCase();
    if (agentType === 'agno') return 'openai';
    if (agentType === 'claude' || agentType === 'claudecode') return 'claude';
    return null;
  }, [selectedTeam?.agent_type]);

  // Fetch all models using unified API
  const fetchModels = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Use unified API to get both public and user models
      const response = await modelApis.getUnifiedModels();
      const modelList = (response.data || []).map(unifiedToModel);
      setModels(modelList);
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(t('models.errors.load_models_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // Filter models by compatible provider when team is selected
  const filteredModels = useMemo(() => {
    if (!compatibleProvider) return models;
    return models.filter(model => model.provider === compatibleProvider);
  }, [models, compatibleProvider]);

  // Reset selected model when team changes and current selection is not compatible
  // Load models on mount
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Track previous team ID to detect team changes
  const prevTeamIdRef = React.useRef<number | null>(null);
  // Track if initial model selection has been done
  const hasInitializedRef = React.useRef(false);
  // Track user's explicit model selection to preserve after task send
  const userSelectedModelRef = React.useRef<Model | null>(null);

  // Unified model selection logic:
  // 1. On initial load: restore from localStorage or set default
  // 2. On team change: re-validate model selection
  // 3. On model list change: check compatibility
  // 4. Preserve user selection after task sends (when team ID doesn't actually change)
  // 5. Skip auto-initialization when disabled (viewing existing task)
  useEffect(() => {
    const currentTeamId = selectedTeam?.id ?? null;
    const teamChanged = prevTeamIdRef.current !== null && prevTeamIdRef.current !== currentTeamId;
    prevTeamIdRef.current = currentTeamId;

    // Case 1: Team changed - re-validate model selection
    if (teamChanged) {
      // Clear user selection on team change
      userSelectedModelRef.current = null;

      if (showDefaultOption) {
        // New team supports default option, set to default
        setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
      } else if (selectedModel && selectedModel.name !== DEFAULT_MODEL_NAME) {
        // Check if current model is still compatible
        const isStillCompatible = filteredModels.some(
          m => m.name === selectedModel.name && m.type === selectedModel.type
        );
        if (!isStillCompatible) {
          setSelectedModel(null);
        }
      } else {
        // Clear selection for non-default teams
        setSelectedModel(null);
      }
      return;
    }

    // Case 2: Initial load - restore from localStorage or set default
    // IMPORTANT: Skip auto-initialization when disabled (viewing existing task with model already set)
    if (!hasInitializedRef.current && filteredModels.length > 0 && !disabled) {
      hasInitializedRef.current = true;

      if (showDefaultOption) {
        // If all bots have predefined models, auto-select "Default"
        if (!selectedModel || selectedModel.name !== DEFAULT_MODEL_NAME) {
          setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
        }
        return;
      }

      // Try to restore from localStorage
      if (!selectedModel) {
        const lastSelectedId = localStorage.getItem(LAST_SELECTED_MODEL_KEY);
        const lastSelectedType = localStorage.getItem(
          LAST_SELECTED_MODEL_TYPE_KEY
        ) as ModelTypeEnum | null;

        if (lastSelectedId && lastSelectedId !== DEFAULT_MODEL_NAME) {
          const foundModel = filteredModels.find(m => {
            if (lastSelectedType) {
              return m.name === lastSelectedId && m.type === lastSelectedType;
            }
            return m.name === lastSelectedId;
          });
          if (foundModel) {
            setSelectedModel(foundModel);
            // Store as user selection for preservation
            userSelectedModelRef.current = foundModel;
          }
        }
      }
      return;
    }

    // Mark as initialized when disabled (already has a model from task)
    if (!hasInitializedRef.current && disabled && selectedModel) {
      hasInitializedRef.current = true;
      return;
    }

    // Case 3: Preserve user's explicit selection (e.g., after sending a task)
    // If user has explicitly selected a model and it's compatible, keep it
    if (
      hasInitializedRef.current &&
      userSelectedModelRef.current &&
      !teamChanged &&
      filteredModels.length > 0
    ) {
      const userModel = userSelectedModelRef.current;
      // Check if user's model is still valid
      const isUserModelValid =
        userModel.name === DEFAULT_MODEL_NAME ||
        filteredModels.some(m => m.name === userModel.name && m.type === userModel.type);

      if (isUserModelValid && selectedModel?.name !== userModel.name) {
        setSelectedModel(userModel);
        return;
      }
    }

    // Case 4: Model list changed after initialization - check compatibility
    // IMPORTANT: Skip compatibility check when disabled (viewing existing task)
    if (
      hasInitializedRef.current &&
      selectedModel &&
      selectedModel.name !== DEFAULT_MODEL_NAME &&
      !disabled
    ) {
      const isStillCompatible = filteredModels.some(
        m => m.name === selectedModel.name && m.type === selectedModel.type
      );
      if (!isStillCompatible && filteredModels.length > 0) {
        setSelectedModel(null);
        userSelectedModelRef.current = null;
      }
    }
  }, [
    selectedTeam?.id,
    showDefaultOption,
    filteredModels,
    selectedModel,
    setSelectedModel,
    disabled,
  ]);
  // Save selected model to localStorage
  useEffect(() => {
    if (selectedModel) {
      localStorage.setItem(LAST_SELECTED_MODEL_KEY, selectedModel.name);
      if (selectedModel.type) {
        localStorage.setItem(LAST_SELECTED_MODEL_TYPE_KEY, selectedModel.type);
      }
    }
  }, [selectedModel]);

  // Get unique key for model (name + type)
  const getModelKey = (model: Model): string => {
    return `${model.name}:${model.type || ''}`;
  };

  // Handle model selection
  // Value format: "modelName:modelType" to uniquely identify models
  const handleModelSelect = (value: string) => {
    if (value === DEFAULT_MODEL_NAME) {
      const defaultModel = { name: DEFAULT_MODEL_NAME, provider: '', modelId: '' };
      setSelectedModel(defaultModel);
      // Save user's explicit selection
      userSelectedModelRef.current = defaultModel;
      setIsOpen(false);
      return;
    }
    // Parse value format: "modelName:modelType"
    const [modelName, modelType] = value.split(':');
    const model = filteredModels.find(m => m.name === modelName && m.type === modelType);
    if (model) {
      setSelectedModel(model);
      // Save user's explicit selection
      userSelectedModelRef.current = model;
    }
    setIsOpen(false);
  };

  // Handle force override checkbox
  const handleForceOverrideChange = (checked: boolean | 'indeterminate') => {
    setForceOverride(checked === true);
  };

  // Reset search when popover closes
  useEffect(() => {
    if (!isOpen) {
      setSearchValue('');
    }
  }, [isOpen]);

  // Determine if selector should be disabled
  const isDisabled = disabled || externalLoading || isLoading || isMixedTeam;

  // Check if model selection is required (for legacy teams without predefined models)
  const isModelRequired = !showDefaultOption && !selectedModel;

  // Get bound model names from team bots for display
  const getBoundModelNames = useCallback((): string[] => {
    if (!selectedTeam?.bots || selectedTeam.bots.length === 0) {
      return [];
    }
    return selectedTeam.bots
      .map(botInfo => {
        const config = botInfo.bot?.agent_config;
        if (!config) return '';
        return getModelFromConfig(config as Record<string, unknown>);
      })
      .filter(Boolean);
  }, [selectedTeam?.bots]);

  // Get display text for trigger
  const getTriggerDisplayText = () => {
    if (!selectedModel) {
      if (isLoading) {
        return t('actions.loading');
      }
      // Show required hint for legacy teams without predefined models
      if (isModelRequired) {
        return t('task_submit.model_required', '请选择模型');
      }
      return t('task_submit.select_model', '选择模型');
    }
    if (selectedModel.name === DEFAULT_MODEL_NAME) {
      const defaultLabel = t('task_submit.default_model', '默认');
      const boundModelNames = getBoundModelNames();

      if (boundModelNames.length === 1) {
        return `${defaultLabel} (${boundModelNames[0]})`;
      } else if (boundModelNames.length > 1) {
        // Multiple bots - show first model name + count of others
        return `${defaultLabel} (${boundModelNames[0]} +${boundModelNames.length - 1})`;
      }
      return defaultLabel;
    }
    const displayText = getModelDisplayText(selectedModel);
    if (forceOverride && !isMixedTeam) {
      return `${displayText}(${t('task_submit.override_short', '覆盖')})`;
    }
    return displayText;
  };

  return (
    <div className="flex items-center space-x-2 min-w-0" style={{ maxWidth: isMobile ? 200 : 260 }}>
      <CpuChipIcon
        className={`w-3 h-3 flex-shrink-0 ml-1 ${isModelRequired ? 'text-error' : 'text-text-muted'} ${isLoading || externalLoading ? 'animate-pulse' : ''}`}
      />
      <div className="relative min-w-0 flex-1">
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              role="combobox"
              aria-expanded={isOpen}
              disabled={isDisabled}
              className={cn(
                'flex w-full min-w-0 items-center justify-between text-left',
                'bg-transparent px-0 py-0 text-xs',
                isModelRequired ? 'text-error' : 'text-text-muted',
                'hover:bg-transparent transition-colors',
                'focus:outline-none focus:ring-0',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              <span className="truncate flex-1 min-w-0" title={selectedModel?.name || ''}>
                {getTriggerDisplayText()}
              </span>
            </button>
          </PopoverTrigger>

          <PopoverContent
            className={cn(
              'p-0 w-auto min-w-[280px] max-w-[320px] border border-border bg-base',
              'shadow-xl rounded-xl overflow-hidden'
            )}
            align="start"
            sideOffset={4}
          >
            <Command className="border-0">
              <CommandInput
                placeholder={t('task_submit.search_model', '搜索模型...')}
                value={searchValue}
                onValueChange={setSearchValue}
                className={cn(
                  'h-9 rounded-none border-b border-border',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="max-h-[300px] overflow-y-auto">
                {error ? (
                  <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
                ) : filteredModels.length === 0 ? (
                  <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                    {isLoading ? 'Loading...' : t('models.no_models')}
                  </CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                      {t('branches.no_match')}
                    </CommandEmpty>
                    <CommandGroup>
                      {/* Default option - only show when all bots have predefined models */}
                      {showDefaultOption && (
                        <CommandItem
                          key={DEFAULT_MODEL_NAME}
                          value={`${DEFAULT_MODEL_NAME} ${t('task_submit.default_model', '默认')} ${t('task_submit.use_bot_model', '使用 Bot 预设模型')}`}
                          onSelect={() => handleModelSelect(DEFAULT_MODEL_NAME)}
                          className={cn(
                            'group cursor-pointer select-none',
                            'px-3 py-1.5 text-sm text-text-primary',
                            'rounded-md mx-1 my-[2px]',
                            'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                            'aria-selected:bg-hover',
                            '!flex !flex-row !items-start !gap-3'
                          )}
                        >
                          <Check
                            className={cn(
                              'h-3 w-3 shrink-0 mt-0.5 ml-1',
                              selectedModel?.name === DEFAULT_MODEL_NAME
                                ? 'opacity-100 text-primary'
                                : 'opacity-0 text-text-muted'
                            )}
                          />
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <CpuChipIcon className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className="font-medium text-xs text-text-secondary">
                                {t('task_submit.default_model', '默认')}
                              </span>
                              <span className="text-[10px] text-text-muted">
                                {t('task_submit.use_bot_model', '使用 Bot 预设模型')}
                              </span>
                            </div>
                          </div>
                        </CommandItem>
                      )}
                      {filteredModels.map(model => (
                        <CommandItem
                          key={getModelKey(model)}
                          value={`${model.name} ${model.displayName || ''} ${model.provider} ${model.modelId} ${model.type}`}
                          onSelect={() => handleModelSelect(getModelKey(model))}
                          className={cn(
                            'group cursor-pointer select-none',
                            'px-3 py-1.5 text-sm text-text-primary',
                            'rounded-md mx-1 my-[2px]',
                            'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                            'aria-selected:bg-hover',
                            '!flex !flex-row !items-start !gap-3'
                          )}
                        >
                          <Check
                            className={cn(
                              'h-3 w-3 shrink-0 mt-0.5 ml-1',
                              selectedModel?.name === model.name &&
                                selectedModel?.type === model.type
                                ? 'opacity-100 text-primary'
                                : 'opacity-0 text-text-muted'
                            )}
                          />
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <CpuChipIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />
                            <div className="flex flex-col min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-nowrap">
                                <span
                                  className="font-medium text-xs text-text-secondary truncate min-w-0"
                                  title={getModelDisplayText(model)}
                                >
                                  {getModelDisplayText(model)}
                                </span>
                                {model.type === 'public' && (
                                  <Tag
                                    variant="info"
                                    className="text-[10px] flex-shrink-0 whitespace-nowrap"
                                  >
                                    {t('models.public', '公共')}
                                  </Tag>
                                )}
                              </div>
                              {model.modelId && (
                                <span
                                  className="text-[10px] text-text-muted truncate"
                                  title={model.modelId}
                                >
                                  {model.modelId}
                                </span>
                              )}
                            </div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
              {/* Force override checkbox in dropdown footer - always show when model is selected */}
              {selectedModel && !isMixedTeam && (
                <div className="border-t border-border px-3 py-2">
                  <label
                    className="flex items-center gap-2 cursor-pointer text-xs text-text-secondary hover:text-text-primary"
                    onClick={e => e.stopPropagation()}
                  >
                    <Checkbox
                      id="force-override-model-dropdown"
                      checked={forceOverride}
                      onCheckedChange={handleForceOverrideChange}
                      disabled={disabled || externalLoading}
                      className="h-3.5 w-3.5"
                    />
                    <span>{t('task_submit.force_override_model', '强制覆盖 Bot 绑定的模型')}</span>
                  </label>
                </div>
              )}
              {/* Model Settings Link */}
              <div
                className="border-t border-border bg-base cursor-pointer group flex items-center space-x-2 px-2.5 py-2 text-xs text-text-secondary hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full"
                onClick={() => router.push(paths.settings.models.getHref())}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    router.push(paths.settings.models.getHref());
                  }
                }}
              >
                <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="font-medium group-hover:text-text-primary">
                  {t('models.manage', '模型设置')}
                </span>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
