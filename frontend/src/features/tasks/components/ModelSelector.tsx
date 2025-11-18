// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { Select, theme } from 'antd';
import { CpuChipIcon } from '@heroicons/react/24/outline';
import { apiClient } from '@/apis/client';
import { useTranslation } from '@/hooks/useTranslation';
import { useMediaQuery } from '@/hooks/useMediaQuery';

interface ModelSelectorProps {
  selectedModel: string | null;
  setSelectedModel: (model: string | null) => void;
  disabled?: boolean;
  isLoading?: boolean;
}

interface ModelOption {
  name: string;
}

export default function ModelSelector({
  selectedModel,
  setSelectedModel,
  disabled = false,
  isLoading = false,
}: ModelSelectorProps) {
  const { t } = useTranslation('common');
  const { token } = theme.useToken();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch models from API
  useEffect(() => {
    const fetchModels = async () => {
      setModelsLoading(true);
      setError(null);
      try {
        const response = await apiClient.get<{ data: ModelOption[] }>('/models/names', {
          agent_name: 'ClaudeCode',
        });
        setModels(response.data || []);
      } catch (err) {
        console.error('Failed to fetch models:', err);
        setError('Failed to load models');
        setModels([]);
      } finally {
        setModelsLoading(false);
      }
    };

    fetchModels();
  }, []);

  // Validate selectedModel exists in models list
  useEffect(() => {
    if (selectedModel && models.length > 0) {
      const exists = models.some(m => m.name === selectedModel);
      if (!exists) {
        console.warn(
          `Selected model "${selectedModel}" not found in models list, clearing selection`
        );
        setSelectedModel(null);
      }
    }
  }, [selectedModel, models, setSelectedModel]);

  const handleChange = (value: string | null) => {
    setSelectedModel(value);
  };

  const modelOptions = useMemo(() => {
    return models.map(model => ({
      label: (
        <span className="font-medium text-xs text-text-primary truncate" title={model.name}>
          {model.name}
        </span>
      ),
      value: model.name,
    }));
  }, [models]);

  const filterOption = (input: string, option?: { label: React.ReactNode; value: string }) => {
    if (!option) return false;
    return option.value.toLowerCase().includes(input.toLowerCase());
  };

  if (error) {
    return null; // Hide selector if models failed to load
  }

  return (
    <div className="flex items-baseline space-x-1 min-w-0">
      <CpuChipIcon
        className={`w-3 h-3 text-text-muted flex-shrink-0 ${modelsLoading || isLoading ? 'animate-pulse' : ''}`}
      />
      <Select
        showSearch
        allowClear
        value={selectedModel}
        placeholder={
          <span className="text-sx truncate h-2">
            {modelsLoading ? t('chat.model_loading') || 'Loading...' : t('chat.select_model') || 'Select Model'}
          </span>
        }
        className="repository-selector min-w-0 truncate"
        style={{
          width: 'auto',
          maxWidth: isMobile ? 150 : 200,
          display: 'inline-block',
          paddingRight: 20,
        }}
        popupMatchSelectWidth={false}
        styles={{ popup: { root: { maxWidth: 280 } } }}
        classNames={{ popup: { root: 'repository-selector-dropdown custom-scrollbar' } }}
        disabled={disabled || modelsLoading}
        loading={modelsLoading}
        size="small"
        filterOption={filterOption}
        onChange={handleChange}
        notFoundContent={
          <div className="px-3 py-2 text-sm text-text-muted">
            {t('chat.no_model_found') || 'No model found'}
          </div>
        }
        options={modelOptions}
      />
    </div>
  );
}
