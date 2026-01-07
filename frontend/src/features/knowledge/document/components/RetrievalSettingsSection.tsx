// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Slider, DualWeightSlider } from '@/components/ui/slider'
import { useTranslation } from '@/hooks/useTranslation'
import { useRetrievers } from '../hooks/useRetrievers'
import { useEmbeddingModels } from '../hooks/useEmbeddingModels'
import { useRetrievalMethods } from '../hooks/useRetrievalMethods'
import Link from 'next/link'

export interface RetrievalConfig {
  retriever_name: string
  retriever_namespace: string
  embedding_config: {
    model_name: string
    model_namespace: string
  }
  retrieval_mode?: 'vector' | 'keyword' | 'hybrid'
  top_k?: number
  score_threshold?: number
  hybrid_weights?: {
    vector_weight: number
    keyword_weight: number
  }
}

interface RetrievalSettingsSectionProps {
  config: Partial<RetrievalConfig>
  onChange: (config: Partial<RetrievalConfig>) => void
  readOnly?: boolean
  partialReadOnly?: boolean // When true, only retriever and embedding model are read-only
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
}

export function RetrievalSettingsSection({
  config,
  onChange,
  readOnly = false,
  partialReadOnly = false,
  scope,
  groupName,
}: RetrievalSettingsSectionProps) {
  const { t } = useTranslation('knowledge')
  const { retrievers, loading: loadingRetrievers } = useRetrievers(scope, groupName)
  const { models: embeddingModels, loading: loadingModels } = useEmbeddingModels(scope, groupName)
  const { methods: retrievalMethods, loading: loadingMethods } = useRetrievalMethods()

  const [topK, setTopK] = useState(config.top_k ?? 5)
  const [scoreThreshold, setScoreThreshold] = useState(config.score_threshold ?? 0.7)
  const [vectorWeight, setVectorWeight] = useState(config.hybrid_weights?.vector_weight ?? 0.7)

  // Sync local state with config prop changes (e.g., when data is loaded from backend)
  useEffect(() => {
    setTopK(config.top_k ?? 5)
  }, [config.top_k])

  useEffect(() => {
    setScoreThreshold(config.score_threshold ?? 0.7)
  }, [config.score_threshold])

  useEffect(() => {
    setVectorWeight(config.hybrid_weights?.vector_weight ?? 0.7)
  }, [config.hybrid_weights?.vector_weight])

  // Generate unique key for retriever (name + namespace)
  // Use '::' as separator since it's unlikely to appear in names/namespaces
  const getRetrieverKey = (name: string, namespace: string) => `${namespace}::${name}`

  // Get current retriever key from config
  const currentRetrieverKey =
    config.retriever_name && config.retriever_namespace
      ? getRetrieverKey(config.retriever_name, config.retriever_namespace)
      : ''

  // Get available retrieval modes for selected retriever
  const selectedRetriever = retrievers.find(
    r => getRetrieverKey(r.name, r.namespace) === currentRetrieverKey
  )
  const availableModes = useMemo(() => {
    return selectedRetriever
      ? retrievalMethods[selectedRetriever.storageType] || ['vector']
      : ['vector']
  }, [selectedRetriever, retrievalMethods])

  // Ensure vector mode is selected if current mode is not available
  // Only reset if retrievers AND retrieval methods are loaded and we have a valid selection
  useEffect(() => {
    if (
      !loadingRetrievers &&
      !loadingMethods &&
      selectedRetriever &&
      config.retrieval_mode &&
      !availableModes.includes(config.retrieval_mode)
    ) {
      onChange({ ...config, retrieval_mode: 'vector' })
    }
  }, [availableModes, config, onChange, loadingRetrievers, loadingMethods, selectedRetriever])

  // Auto-select retriever when:
  // 1. No retriever is selected, OR
  // 2. The currently selected retriever is not in the available list (scope/groupName changed)
  // The retrievers list is already sorted by priority in useRetrievers hook:
  // - group scope: group > public
  // - personal scope (default): user > public
  // So we just select the first one
  useEffect(() => {
    if (!loadingRetrievers && retrievers.length > 0) {
      const currentRetrieverExists =
        config.retriever_name &&
        retrievers.some(
          r => r.name === config.retriever_name && r.namespace === config.retriever_namespace
        )

      // Auto-select first retriever if no selection or current selection is not available
      if (!config.retriever_name || !currentRetrieverExists) {
        const firstRetriever = retrievers[0]
        onChange({
          ...config,
          retriever_name: firstRetriever.name,
          retriever_namespace: firstRetriever.namespace,
        })
      }
    }
  }, [loadingRetrievers, retrievers, config, onChange])

  // Auto-select embedding model when:
  // 1. No model is selected, OR
  // 2. The currently selected model is not in the available list (scope/groupName changed)
  useEffect(() => {
    if (!loadingModels && embeddingModels.length > 0) {
      const currentModelExists =
        config.embedding_config?.model_name &&
        embeddingModels.some(m => m.name === config.embedding_config?.model_name)

      // Auto-select first model if no selection or current selection is not available
      if (!config.embedding_config?.model_name || !currentModelExists) {
        const firstModel = embeddingModels[0]
        onChange({
          ...config,
          embedding_config: {
            model_name: firstModel.name,
            model_namespace: firstModel.namespace || 'default',
          },
        })
      }
    }
  }, [loadingModels, embeddingModels, config, onChange])

  const handleRetrieverChange = (value: string) => {
    // value is in format "namespace::name" (generated by getRetrieverKey)
    const retriever = retrievers.find(r => getRetrieverKey(r.name, r.namespace) === value)
    if (retriever) {
      onChange({
        ...config,
        retriever_name: retriever.name,
        retriever_namespace: retriever.namespace,
      })
    }
  }

  const handleEmbeddingModelChange = (value: string) => {
    const model = embeddingModels.find(m => m.name === value)
    if (model) {
      onChange({
        ...config,
        embedding_config: {
          model_name: model.name,
          model_namespace: model.namespace || 'default',
        },
      })
    }
  }

  const handleRetrievalModeChange = (value: string) => {
    onChange({
      ...config,
      retrieval_mode: value as 'vector' | 'keyword' | 'hybrid',
    })
  }

  const handleTopKChange = useCallback(
    (values: number[]) => {
      const newValue = values[0]
      setTopK(newValue)
      onChange({ ...config, top_k: newValue })
    },
    [config, onChange]
  )

  const handleScoreThresholdChange = useCallback(
    (values: number[]) => {
      const newValue = values[0]
      setScoreThreshold(newValue)
      onChange({ ...config, score_threshold: newValue })
    },
    [config, onChange]
  )

  const handleWeightChange = useCallback(
    (value: number) => {
      setVectorWeight(value)
      const newKeywordWeight = Math.round((1 - value) * 100) / 100
      onChange({
        ...config,
        hybrid_weights: {
          vector_weight: value,
          keyword_weight: newKeywordWeight,
        },
      })
    },
    [config, onChange]
  )

  // Helper function to get source type label
  const getSourceTypeLabel = (type: string) => {
    const typeKey = type as 'user' | 'public' | 'group'
    return t(`document.retrieval.sourceType.${typeKey}`)
  }

  // Format retriever label with source type
  const formatRetrieverLabel = (retriever: (typeof retrievers)[0]) => {
    const displayName = retriever.displayName || retriever.name
    const sourceLabel = getSourceTypeLabel(retriever.type)
    return `[${sourceLabel}] ${displayName}`
  }

  // Format model label with source type
  const formatModelLabel = (model: (typeof embeddingModels)[0]) => {
    const displayName = model.displayName || model.name
    const sourceLabel = getSourceTypeLabel(model.type)
    return `[${sourceLabel}] ${displayName}`
  }

  // Determine if retriever and embedding model should be disabled
  // They are disabled when readOnly is true OR when partialReadOnly is true
  const isRetrieverDisabled = readOnly || partialReadOnly
  const isEmbeddingDisabled = readOnly || partialReadOnly
  // Other settings are only disabled when readOnly is true (not partialReadOnly)
  const isOtherSettingsDisabled = readOnly

  return (
    <div className="space-y-4">
      {/* Retriever Selection */}
      <div className="space-y-2">
        <Label htmlFor="retriever">{t('document.retrieval.retriever')}</Label>
        {loadingRetrievers ? (
          <div className="text-sm text-text-secondary">{t('common:actions.loading')}</div>
        ) : retrievers.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-warning">{t('document.retrieval.noRetriever')}</p>
            <Link
              href="/settings?section=personal&tab=personal-retrievers"
              className="text-sm text-primary hover:underline"
            >
              {t('document.goToSettings')}
            </Link>
          </div>
        ) : (
          <>
            <SearchableSelect
              value={currentRetrieverKey}
              onValueChange={handleRetrieverChange}
              placeholder={t('document.retrieval.retrieverSelect')}
              searchPlaceholder={t('document.retrieval.searchPlaceholder')}
              disabled={isRetrieverDisabled}
              items={retrievers.map(retriever => ({
                value: getRetrieverKey(retriever.name, retriever.namespace),
                label: formatRetrieverLabel(retriever),
              }))}
            />
            <p className="text-xs text-text-muted">{t('document.retrieval.retrieverHint')}</p>
          </>
        )}
      </div>

      {/* Embedding Model Selection */}
      <div className="space-y-2">
        <Label htmlFor="embedding-model">{t('document.retrieval.embeddingModel')}</Label>
        {loadingModels ? (
          <div className="text-sm text-text-secondary">{t('common:actions.loading')}</div>
        ) : embeddingModels.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-warning">{t('document.retrieval.noEmbeddingModel')}</p>
            <Link
              href="/settings?section=personal&tab=personal-models"
              className="text-sm text-primary hover:underline"
            >
              {t('document.goToSettings')}
            </Link>
          </div>
        ) : (
          <>
            <SearchableSelect
              value={config.embedding_config?.model_name || ''}
              onValueChange={handleEmbeddingModelChange}
              placeholder={t('document.retrieval.embeddingModelSelect')}
              searchPlaceholder={t('document.retrieval.searchPlaceholder')}
              disabled={isEmbeddingDisabled}
              items={embeddingModels.map(model => ({
                value: model.name,
                label: formatModelLabel(model),
              }))}
            />
            <p className="text-xs text-text-muted">{t('document.retrieval.embeddingModelHint')}</p>
          </>
        )}
      </div>

      {/* Retrieval Mode */}
      <div className="space-y-2">
        <Label>{t('document.retrieval.retrievalMode')}</Label>
        <RadioGroup
          value={config.retrieval_mode || 'vector'}
          onValueChange={handleRetrievalModeChange}
          disabled={isOtherSettingsDisabled}
        >
          {availableModes.includes('vector') && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="vector" id="mode-vector" />
              <Label htmlFor="mode-vector" className="font-normal cursor-pointer">
                {t('document.retrieval.vector')}
              </Label>
            </div>
          )}
          {availableModes.includes('keyword') && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="keyword" id="mode-keyword" />
              <Label htmlFor="mode-keyword" className="font-normal cursor-pointer">
                {t('document.retrieval.keyword')}
              </Label>
            </div>
          )}
          {availableModes.includes('hybrid') && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="hybrid" id="mode-hybrid" />
              <Label htmlFor="mode-hybrid" className="font-normal cursor-pointer">
                {t('document.retrieval.hybrid')}
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
        <p className="text-xs text-text-muted">{t('document.retrieval.topKHint')}</p>
      </div>

      {/* Score Threshold Slider */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="score-threshold">Score {t('document.retrieval.threshold')}</Label>
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
        <p className="text-xs text-text-muted">{t('document.retrieval.scoreThresholdHint')}</p>
      </div>

      {/* Hybrid Weights (only when hybrid mode is selected) */}
      {config.retrieval_mode === 'hybrid' && (
        <div className="space-y-3 p-4 border border-border rounded-lg bg-bg-muted">
          <Label>{t('document.retrieval.hybridWeights')}</Label>
          <DualWeightSlider
            value={vectorWeight}
            onChange={handleWeightChange}
            leftLabel={t('document.retrieval.semanticWeight')}
            rightLabel={t('document.retrieval.keywordWeight')}
            disabled={isOtherSettingsDisabled}
          />
          <p className="text-xs text-text-muted">{t('document.retrieval.weightSum')}</p>
        </div>
      )}
    </div>
  )
}
