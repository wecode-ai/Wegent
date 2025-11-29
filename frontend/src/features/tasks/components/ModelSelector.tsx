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
import { isPredefinedModel } from '@/features/settings/services/bots';

// Model type for component props (extended with type information)
export interface Model {
  name: string;
  provider: string; // 'openai' | 'claude'
  modelId: string;
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
    type: unified.type,
  };
}

// Helper function to check if all bots in a team have predefined models
function allBotsHavePredefinedModel(team: TeamWithBotDetails | null): boolean {
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

  // Load models on mount
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Restore last selected model from localStorage or set default
  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      const lastSelectedId = localStorage.getItem(LAST_SELECTED_MODEL_KEY);
      const lastSelectedType = localStorage.getItem(
        LAST_SELECTED_MODEL_TYPE_KEY
      ) as ModelTypeEnum | null;
      if (lastSelectedId) {
        // Check if it was the default option
        if (lastSelectedId === DEFAULT_MODEL_NAME && showDefaultOption) {
          setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
          return;
        }
        // Find model by name and type (if type was saved)
        const foundModel = models.find(m => {
          if (lastSelectedType) {
            return m.name === lastSelectedId && m.type === lastSelectedType;
          }
          return m.name === lastSelectedId;
        });
        if (foundModel) {
          setSelectedModel(foundModel);
          return;
        }
      }
      // If showDefaultOption is true and no previous selection, default to "Default"
      if (showDefaultOption) {
        setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
      }
    }
  }, [models, selectedModel, setSelectedModel, showDefaultOption]);

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
      setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
      setIsOpen(false);
      return;
    }
    // Parse value format: "modelName:modelType"
    const [modelName, modelType] = value.split(':');
    const model = models.find(m => m.name === modelName && m.type === modelType);
    if (model) {
      setSelectedModel(model);
    }
    setIsOpen(false);
  };

  // Handle force override checkbox
  const handleForceOverrideChange = (checked: boolean | 'indeterminate') => {
    setForceOverride(checked === true);
  };

  // Get provider label
  const getProviderLabel = (provider: string) => {
    return provider === 'openai' ? 'OpenAI' : 'Anthropic';
  };

  // Reset search when popover closes
  useEffect(() => {
    if (!isOpen) {
      setSearchValue('');
    }
  }, [isOpen]);

  // Determine if selector should be disabled
  const isDisabled = disabled || externalLoading || isLoading || isMixedTeam;

  // Get display text for trigger
  const getTriggerDisplayText = () => {
    if (!selectedModel) {
      return isLoading ? t('actions.loading') : t('task_submit.select_model', '选择模型');
    }
    if (selectedModel.name === DEFAULT_MODEL_NAME) {
      return t('task_submit.default_model', '默认');
    }
    if (forceOverride && !isMixedTeam) {
      return `${selectedModel.name}(${t('task_submit.override_short', '覆盖')})`;
    }
    return selectedModel.name;
  };

  return (
    <div className="flex items-center gap-0">
      {/* Model selector with integrated checkbox in dropdown */}
      <div
        className="flex items-center space-x-2 min-w-0"
        style={{ maxWidth: isMobile ? 140 : 180 }}
      >
        <CpuChipIcon
          className={`w-3 h-3 text-text-muted flex-shrink-0 ml-1 ${isLoading || externalLoading ? 'animate-pulse' : ''}`}
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
                  'flex h-9 w-full min-w-0 items-center justify-between rounded-lg text-left',
                  'bg-transparent px-0 text-xs text-text-muted',
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
                  ) : models.length === 0 ? (
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
                        {models.map(model => (
                          <CommandItem
                            key={getModelKey(model)}
                            value={`${model.name} ${model.provider} ${model.modelId} ${model.type}`}
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
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className="font-medium text-xs text-text-secondary truncate"
                                    title={model.name}
                                  >
                                    {model.name}
                                  </span>
                                  {model.type === 'public' && (
                                    <Tag variant="info" className="text-[10px]">
                                      {t('models.public', '公共')}
                                    </Tag>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <Tag variant="default" className="text-[10px] capitalize">
                                    {getProviderLabel(model.provider)}
                                  </Tag>
                                  <span
                                    className="text-[10px] text-text-muted truncate"
                                    title={model.modelId}
                                  >
                                    {model.modelId}
                                  </span>
                                </div>
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
                      <span>
                        {t('task_submit.force_override_model', '强制覆盖 Bot 绑定的模型')}
                      </span>
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
                  <span className="font-medium group-hover:text-text-primary">{t('models.manage', '模型设置')}</span>
                </div>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}
