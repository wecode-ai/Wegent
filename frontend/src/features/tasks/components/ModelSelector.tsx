// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { CpuChipIcon } from '@heroicons/react/24/outline';
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { modelApis, ModelCRD } from '@/apis/models';
import { Team } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';

const STORAGE_KEY = 'last_selected_model_id';

interface ModelSelectorProps {
  selectedModel: ModelCRD | null;
  setSelectedModel: (model: ModelCRD | null) => void;
  forceOverride: boolean;
  setForceOverride: (force: boolean) => void;
  selectedTeam: Team | null;
  disabled: boolean;
  isLoading?: boolean;
}

export default function ModelSelector({
  selectedModel,
  setSelectedModel,
  forceOverride,
  setForceOverride,
  selectedTeam,
  disabled,
  isLoading = false,
}: ModelSelectorProps) {
  const { t } = useTranslation('common');
  const [models, setModels] = useState<ModelCRD[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  // Detect mixed-format teams (teams with both Agno and ClaudeCode bots)
  const isMixedTeam = useMemo(() => {
    if (!selectedTeam || !selectedTeam.bots || selectedTeam.bots.length === 0) {
      return false;
    }
    const agentTypes = new Set(
      selectedTeam.bots
        .map(bot => bot.bot?.agent_name)
        .filter((name): name is string => name !== undefined)
    );
    return agentTypes.size > 1;
  }, [selectedTeam]);

  // Load models on mount
  useEffect(() => {
    const loadModels = async () => {
      setLoadingModels(true);
      try {
        const modelsData = await modelApis.fetchAllModels();
        setModels(modelsData);

        // Try to restore last selected model from localStorage
        const lastModelId = localStorage.getItem(STORAGE_KEY);
        if (lastModelId && !selectedModel) {
          const lastModel = modelsData.find(m => m.metadata.name === lastModelId);
          if (lastModel) {
            setSelectedModel(lastModel);
          }
        }
      } catch (error) {
        console.error('Failed to load models:', error);
      } finally {
        setLoadingModels(false);
      }
    };

    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount, setSelectedModel is stable

  // Save selected model to localStorage when changed
  useEffect(() => {
    if (selectedModel) {
      localStorage.setItem(STORAGE_KEY, selectedModel.metadata.name);
    }
  }, [selectedModel]);

  // Handle model selection change
  const handleModelChange = (modelName: string) => {
    const model = models.find(m => m.metadata.name === modelName);
    setSelectedModel(model || null);
  };

  // Get provider display name
  const getProviderDisplayName = (provider: string): string => {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'claude') return 'Anthropic';
    return provider;
  };

  // Build model items for SearchableSelect
  const modelItems: SearchableSelectItem[] = models.map(model => {
    const provider = model.spec.modelConfig.env.model;
    const modelId = model.spec.modelConfig.env.model_id;
    const providerDisplay = getProviderDisplayName(provider);

    return {
      value: model.metadata.name,
      label: model.metadata.name,
      searchText: `${model.metadata.name} ${providerDisplay} ${modelId}`,
      content: (
        <div className="flex items-center gap-2 min-w-0">
          <CpuChipIcon className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{model.metadata.name}</div>
            <div className="text-xs text-text-muted truncate">
              {providerDisplay} - {modelId}
            </div>
          </div>
        </div>
      ),
    };
  });

  // Determine placeholder text
  const getPlaceholder = () => {
    if (loadingModels) {
      return t('models.loading_models');
    }
    if (isMixedTeam) {
      return t('models.mixed_team_warning');
    }
    if (models.length === 0) {
      return t('models.no_models_available');
    }
    return t('models.select_a_model');
  };

  return (
    <div className="space-y-3">
      {/* Model selection dropdown */}
      <div className="flex items-center space-x-2 min-w-0">
        <CpuChipIcon className="w-3 h-3 text-text-muted flex-shrink-0 ml-1" />
        <div className="relative min-w-0 flex-1">
          <SearchableSelect
            value={selectedModel?.metadata.name}
            onValueChange={handleModelChange}
            disabled={disabled || isLoading || loadingModels || isMixedTeam}
            placeholder={getPlaceholder()}
            searchPlaceholder={t('models.search_model')}
            items={modelItems}
            emptyText={t('models.no_models_available')}
            noMatchText={t('models.no_match')}
            showChevron={true}
          />
        </div>
      </div>

      {/* Force override checkbox */}
      {selectedModel && !isMixedTeam && (
        <div className="flex items-center space-x-2 ml-6">
          <Checkbox
            id="force-override"
            checked={forceOverride}
            onCheckedChange={checked => setForceOverride(checked === true)}
            disabled={disabled || isLoading}
          />
          <Label
            htmlFor="force-override"
            className="text-xs text-text-muted cursor-pointer select-none"
          >
            {t('models.force_override')}
          </Label>
        </div>
      )}

      {/* Mixed team warning */}
      {isMixedTeam && (
        <Alert className="bg-muted border-border ml-6">
          <AlertDescription className="text-sm text-text-muted">
            {t('models.mixed_team_warning')}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
