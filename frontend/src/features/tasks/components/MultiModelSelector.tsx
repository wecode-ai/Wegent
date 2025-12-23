// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useMemo } from 'react';
import { Check, ChevronDown, X, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { modelApis, UnifiedModel } from '@/apis/models';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';

export interface SelectedModel {
  name: string;
  displayName: string;
  type: 'public' | 'user';
}

interface MultiModelSelectorProps {
  _teamId?: number;
  agentType?: string;
  compareMode: boolean;
  onCompareModeChange: (enabled: boolean) => void;
  selectedModels: SelectedModel[];
  onSelectedModelsChange: (models: SelectedModel[]) => void;
  disabled?: boolean;
  className?: string;
}

export function MultiModelSelector({
  _teamId,
  agentType,
  compareMode,
  onCompareModeChange,
  selectedModels,
  onSelectedModelsChange,
  disabled = false,
  className,
}: MultiModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch available models
  useEffect(() => {
    const fetchModels = async () => {
      setLoading(true);
      try {
        const response = await modelApis.getUnifiedModels();
        // Response is UnifiedModelListResponse with data array
        let modelList = response.data || [];
        // Filter models based on agent type if provided
        if (agentType) {
          modelList = modelList.filter((_m: UnifiedModel) => {
            // Only show compatible models
            if (agentType === 'Chat') {
              return true; // Chat supports all models
            }
            return true; // For now, show all models
          });
        }
        setModels(modelList);
      } catch (error) {
        console.error('Failed to fetch models:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchModels();
  }, [agentType]);

  // Filter models by search
  const filteredModels = useMemo(() => {
    if (!search) return models;
    const searchLower = search.toLowerCase();
    return models.filter(
      (m: UnifiedModel) =>
        m.name.toLowerCase().includes(searchLower) ||
        m.displayName?.toLowerCase().includes(searchLower)
    );
  }, [models, search]);

  const handleModelToggle = (model: UnifiedModel) => {
    const modelType = model.type === 'public' ? 'public' : 'user';
    const displayName = model.displayName || model.name;
    const selectedModel: SelectedModel = {
      name: model.name,
      displayName,
      type: modelType,
    };

    const isSelected = selectedModels.some(m => m.name === model.name);

    if (isSelected) {
      // Remove model
      onSelectedModelsChange(selectedModels.filter(m => m.name !== model.name));
    } else {
      // Add model (max 4)
      if (selectedModels.length < 4) {
        onSelectedModelsChange([...selectedModels, selectedModel]);
      }
    }
  };

  const handleRemoveModel = (modelName: string) => {
    onSelectedModelsChange(selectedModels.filter(m => m.name !== modelName));
  };

  const handleCompareModeToggle = (enabled: boolean) => {
    onCompareModeChange(enabled);
    if (!enabled) {
      // When disabling compare mode, keep only the first model
      if (selectedModels.length > 1) {
        onSelectedModelsChange([selectedModels[0]]);
      }
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Compare Mode Toggle */}
      <div className="flex items-center gap-2">
        <Switch
          id="compare-mode"
          checked={compareMode}
          onCheckedChange={handleCompareModeToggle}
          disabled={disabled}
        />
        <Label
          htmlFor="compare-mode"
          className="text-sm text-text-secondary cursor-pointer flex items-center gap-1"
        >
          <Layers className="h-4 w-4" />
          {t('chat.compare.mode')}
        </Label>
      </div>

      {/* Model Selector (visible in compare mode) */}
      {compareMode && (
        <div className="flex flex-col gap-2">
          {/* Selected Models Display */}
          <div className="flex flex-wrap gap-1">
            {selectedModels.map(model => (
              <Badge
                key={model.name}
                variant="secondary"
                className="flex items-center gap-1 pl-2 pr-1"
              >
                <span className="truncate max-w-[120px]">{model.displayName}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveModel(model.name)}
                  className="hover:bg-bg-hover rounded p-0.5"
                  disabled={disabled}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>

          {/* Model Picker */}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={open}
                disabled={disabled || selectedModels.length >= 4}
                className="w-full justify-between"
              >
                <span className="text-text-secondary">
                  {selectedModels.length === 0
                    ? t('chat.compare.selectModels')
                    : `${selectedModels.length}/4 ${t('chat.compare.modelsSelected')}`}
                </span>
                <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="start">
              <div className="p-2 border-b border-border">
                <Input
                  placeholder={t('chat.compare.searchModels')}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="h-8"
                />
              </div>
              <div className="max-h-[240px] overflow-y-auto">
                {loading ? (
                  <div className="p-4 text-center text-text-muted text-sm">
                    {t('common.loading')}
                  </div>
                ) : filteredModels.length === 0 ? (
                  <div className="p-4 text-center text-text-muted text-sm">
                    {t('chat.compare.noModels')}
                  </div>
                ) : (
                  filteredModels.map((model: UnifiedModel) => {
                    const isSelected = selectedModels.some(m => m.name === model.name);
                    const displayName = model.displayName || model.name;
                    const isDisabled = !isSelected && selectedModels.length >= 4;

                    return (
                      <button
                        key={model.name}
                        type="button"
                        onClick={() => handleModelToggle(model)}
                        disabled={isDisabled}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2 text-left',
                          'hover:bg-bg-hover transition-colors',
                          isDisabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        <div className="flex flex-col">
                          <span className="text-sm font-medium truncate">{displayName}</span>
                          <span className="text-xs text-text-muted">
                            {model.type === 'public'
                              ? t('chat.compare.publicModel')
                              : t('chat.compare.userModel')}
                          </span>
                        </div>
                        {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="p-2 border-t border-border">
                <p className="text-xs text-text-muted">{t('chat.compare.selectHint')}</p>
              </div>
            </PopoverContent>
          </Popover>

          {/* Validation Message */}
          {selectedModels.length > 0 && selectedModels.length < 2 && (
            <p className="text-xs text-warning">{t('chat.compare.selectAtLeastTwo')}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default MultiModelSelector;
