// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Slider, DualWeightSlider } from '@/components/ui/slider';
import { useTranslation } from '@/hooks/useTranslation';
import { useRetrievers } from '../hooks/useRetrievers';
import { useEmbeddingModels } from '../hooks/useEmbeddingModels';
import { useRetrievalMethods } from '../hooks/useRetrievalMethods';
import Link from 'next/link';

export interface RetrievalConfig {
  retriever_name: string;
  retriever_namespace: string;
  embedding_config: {
    model_name: string;
    model_namespace: string;
  };
  retrieval_mode?: 'vector' | 'keyword' | 'hybrid';
  top_k?: number;
  score_threshold?: number;
  hybrid_weights?: {
    vector_weight: number;
    keyword_weight: number;
  };
}

interface RetrievalSettingsSectionProps {
  config: Partial<RetrievalConfig>;
  onChange: (config: Partial<RetrievalConfig>) => void;
  readOnly?: boolean;
  partialReadOnly?: boolean; // When true, only retriever and embedding model are read-only
  scope?: 'personal' | 'group' | 'all';
  groupName?: string;
}

export function RetrievalSettingsSection({
  config,
  onChange,
  readOnly = false,
  partialReadOnly = false,
  scope,
  groupName,
}: RetrievalSettingsSectionProps) {
  const { t } = useTranslation();
  const { retrievers, loading: loadingRetrievers } = useRetrievers(scope, groupName);
  const { models: embeddingModels, loading: loadingModels } = useEmbeddingModels();
  const { methods: retrievalMethods } = useRetrievalMethods();

  const [topK, setTopK] = useState(config.top_k ?? 5);
  const [scoreThreshold, setScoreThreshold] = useState(config.score_threshold ?? 0.7);
  const [vectorWeight, setVectorWeight] = useState(config.hybrid_weights?.vector_weight ?? 0.7);

  // Get available retrieval modes for selected retriever
  const selectedRetriever = retrievers.find(r => r.name === config.retriever_name);
  const availableModes = useMemo(() => {
    return selectedRetriever
      ? retrievalMethods[selectedRetriever.storageType] || ['vector']
      : ['vector'];
  }, [selectedRetriever, retrievalMethods]);

  // Ensure vector mode is selected if current mode is not available
  useEffect(() => {
    if (config.retrieval_mode && !availableModes.includes(config.retrieval_mode)) {
      onChange({ ...config, retrieval_mode: 'vector' });
    }
  }, [availableModes, config, onChange]);

  // Auto-select first retriever if data exists and no selection
  useEffect(() => {
    if (!loadingRetrievers && retrievers.length > 0 && !config.retriever_name) {
      const firstRetriever = retrievers[0];
      onChange({
        ...config,
        retriever_name: firstRetriever.name,
        retriever_namespace: firstRetriever.namespace,
      });
    }
  }, [loadingRetrievers, retrievers, config.retriever_name]);

  // Auto-select first embedding model if data exists and no selection
  useEffect(() => {
    if (!loadingModels && embeddingModels.length > 0 && !config.embedding_config?.model_name) {
      const firstModel = embeddingModels[0];
      onChange({
        ...config,
        embedding_config: {
          model_name: firstModel.name,
          model_namespace: firstModel.namespace || 'default',
        },
      });
    }
  }, [loadingModels, embeddingModels, config.embedding_config?.model_name]);

  const handleRetrieverChange = (value: string) => {
    const retriever = retrievers.find(r => r.name === value);
    if (retriever) {
      onChange({
        ...config,
        retriever_name: retriever.name,
        retriever_namespace: retriever.namespace,
      });
    }
  };

  const handleEmbeddingModelChange = (value: string) => {
    const model = embeddingModels.find(m => m.name === value);
    if (model) {
      onChange({
        ...config,
        embedding_config: {
          model_name: model.name,
          model_namespace: model.namespace || 'default',
        },
      });
    }
  };

  const handleRetrievalModeChange = (value: string) => {
    onChange({
      ...config,
      retrieval_mode: value as 'vector' | 'keyword' | 'hybrid',
    });
  };

  const handleTopKChange = useCallback(
    (values: number[]) => {
      const newValue = values[0];
      setTopK(newValue);
      onChange({ ...config, top_k: newValue });
    },
    [config, onChange]
  );

  const handleScoreThresholdChange = useCallback(
    (values: number[]) => {
      const newValue = values[0];
      setScoreThreshold(newValue);
      onChange({ ...config, score_threshold: newValue });
    },
    [config, onChange]
  );

  const handleWeightChange = useCallback(
    (value: number) => {
      setVectorWeight(value);
      const newKeywordWeight = Math.round((1 - value) * 100) / 100;
      onChange({
        ...config,
        hybrid_weights: {
          vector_weight: value,
          keyword_weight: newKeywordWeight,
        },
      });
    },
    [config, onChange]
  );

  // Determine if retriever and embedding model should be disabled
  // They are disabled when readOnly is true OR when partialReadOnly is true
  const isRetrieverDisabled = readOnly || partialReadOnly;
  const isEmbeddingDisabled = readOnly || partialReadOnly;
  // Other settings are only disabled when readOnly is true (not partialReadOnly)
  const isOtherSettingsDisabled = readOnly;

  return (
    <div className="space-y-4">
      {/* Retriever Selection */}
      <div className="space-y-2">
        <Label htmlFor="retriever">{t('knowledge.document.retrieval.retriever')}</Label>
        {loadingRetrievers ? (
          <div className="text-sm text-text-secondary">{t('actions.loading')}</div>
        ) : retrievers.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-warning">{t('knowledge.document.retrieval.noRetriever')}</p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              {t('knowledge.document.goToSettings')}
            </Link>
          </div>
        ) : (
          <>
            <SearchableSelect
              value={config.retriever_name || ''}
              onValueChange={handleRetrieverChange}
              placeholder={t('knowledge.document.retrieval.retrieverSelect')}
              disabled={isRetrieverDisabled}
              items={retrievers.map(retriever => ({
                value: retriever.name,
                label: retriever.displayName || retriever.name,
              }))}
            />
            <p className="text-xs text-text-muted">
              {t('knowledge.document.retrieval.retrieverHint')}
            </p>
          </>
        )}
      </div>

      {/* Embedding Model Selection */}
      <div className="space-y-2">
        <Label htmlFor="embedding-model">{t('knowledge.document.retrieval.embeddingModel')}</Label>
        {loadingModels ? (
          <div className="text-sm text-text-secondary">{t('actions.loading')}</div>
        ) : embeddingModels.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-warning">
              {t('knowledge.document.retrieval.noEmbeddingModel')}
            </p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              {t('knowledge.document.goToSettings')}
            </Link>
          </div>
        ) : (
          <>
            <SearchableSelect
              value={config.embedding_config?.model_name || ''}
              onValueChange={handleEmbeddingModelChange}
              placeholder={t('knowledge.document.retrieval.embeddingModelSelect')}
              disabled={isEmbeddingDisabled}
              items={embeddingModels.map(model => ({
                value: model.name,
                label: model.displayName || model.name,
              }))}
            />
            <p className="text-xs text-text-muted">
              {t('knowledge.document.retrieval.embeddingModelHint')}
            </p>
          </>
        )}
      </div>

      {/* Retrieval Mode */}
      <div className="space-y-2">
        <Label>{t('knowledge.document.retrieval.retrievalMode')}</Label>
        <RadioGroup
          value={config.retrieval_mode || 'vector'}
          onValueChange={handleRetrievalModeChange}
          disabled={isOtherSettingsDisabled}
        >
          {availableModes.includes('vector') && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="vector" id="mode-vector" />
              <Label htmlFor="mode-vector" className="font-normal cursor-pointer">
                {t('knowledge.document.retrieval.vector')}
              </Label>
            </div>
          )}
          {availableModes.includes('keyword') && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="keyword" id="mode-keyword" />
              <Label htmlFor="mode-keyword" className="font-normal cursor-pointer">
                {t('knowledge.document.retrieval.keyword')}
              </Label>
            </div>
          )}
          {availableModes.includes('hybrid') && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="hybrid" id="mode-hybrid" />
              <Label htmlFor="mode-hybrid" className="font-normal cursor-pointer">
                {t('knowledge.document.retrieval.hybrid')}
              </Label>
            </div>
          )}
        </RadioGroup>
      </div>

      {/* Top K Slider */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="top-k">Top K</Label>
          <span className="text-sm text-text-secondary font-medium">{topK}</span>
        </div>
        <Slider
          id="top-k"
          value={[topK]}
          onValueChange={handleTopKChange}
          min={1}
          max={10}
          step={1}
          disabled={isOtherSettingsDisabled}
        />
        <p className="text-xs text-text-muted">{t('knowledge.document.retrieval.topKHint')}</p>
      </div>

      {/* Score Threshold Slider */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="score-threshold">
            Score {t('knowledge.document.retrieval.threshold')}
          </Label>
          <span className="text-sm text-text-secondary font-medium">
            {scoreThreshold.toFixed(2)}
          </span>
        </div>
        <Slider
          id="score-threshold"
          value={[scoreThreshold]}
          onValueChange={handleScoreThresholdChange}
          min={0}
          max={1}
          step={0.05}
          disabled={isOtherSettingsDisabled}
        />
        <p className="text-xs text-text-muted">
          {t('knowledge.document.retrieval.scoreThresholdHint')}
        </p>
      </div>

      {/* Hybrid Weights (only when hybrid mode is selected) */}
      {config.retrieval_mode === 'hybrid' && (
        <div className="space-y-3 p-4 border border-border rounded-lg bg-bg-muted">
          <Label>{t('knowledge.document.retrieval.hybridWeights')}</Label>
          <DualWeightSlider
            value={vectorWeight}
            onChange={handleWeightChange}
            leftLabel={t('knowledge.document.retrieval.semanticWeight')}
            rightLabel={t('knowledge.document.retrieval.keywordWeight')}
            disabled={isOtherSettingsDisabled}
          />
          <p className="text-xs text-text-muted">{t('knowledge.document.retrieval.weightSum')}</p>
        </div>
      )}
    </div>
  );
}
