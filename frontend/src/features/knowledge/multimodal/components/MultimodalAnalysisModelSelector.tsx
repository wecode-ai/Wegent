// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  GroupedModelSelect,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import { modelApis, UnifiedModel } from '@/apis/models'
import { useTranslation } from '@/hooks/useTranslation'
import { getModelCapabilities } from '@/lib/model-capabilities'
import type { SummaryModelRef } from '@/types/knowledge'

interface MultimodalAnalysisModelSelectorProps {
  value?: SummaryModelRef | null
  onChange: (value: SummaryModelRef | null) => void
  disabled?: boolean
  error?: string
}

// A model qualifies for KB multimodal analysis only when it is a Gemini model
// that declares supportsVideo=true. The converter pipeline drives Gemini via
// the google-genai SDK (ChatGoogleGenerativeAI) with gs:// media parts, so a
// non-Gemini provider cannot be served even if it declares video support —
// filtering here avoids a "configurable but fails at execution" mismatch.
// supportsVideo is required (strict) because video is the demanding media type;
// a supportsVideo=true Gemini model also handles image analysis, so image-only
// models are excluded rather than offered. provider is the env.model value,
// which ModelEditDialog maps to 'gemini' for every Gemini LLM variant (incl.
// gemini-deep-research). Capability fields are returned as top-level model metadata.
function isGeminiProvider(provider?: string | null): boolean {
  return !!provider && provider.toLowerCase() === 'gemini'
}

function supportsMultimodalAnalysis(model: UnifiedModel): boolean {
  return getModelCapabilities(model).supportsVideo === true && isGeminiProvider(model.provider)
}

export function MultimodalAnalysisModelSelector({
  value,
  onChange,
  disabled = false,
  error,
}: MultimodalAnalysisModelSelectorProps) {
  const { t } = useTranslation('knowledge')
  const [allModels, setAllModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const fetchModels = async () => {
      setLoading(true)
      try {
        const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm')
        const sorted = (response.data || []).filter(supportsMultimodalAnalysis).sort((a, b) => {
          const nameA = a.displayName || a.name
          const nameB = b.displayName || b.name
          return nameA.localeCompare(nameB)
        })
        setAllModels(sorted)
      } catch (err) {
        console.error('Failed to fetch multimodal models:', err)
        setAllModels([])
      } finally {
        setLoading(false)
      }
    }

    fetchModels()
  }, [])

  // Auto-preselect the first available multimodal model when nothing is selected.
  useEffect(() => {
    if (value || loading || allModels.length === 0) return
    const first = allModels[0]
    onChange({
      name: first.name,
      namespace: first.namespace || 'default',
      type: first.type,
    })
  }, [allModels, value, loading, onChange])

  const selectedModel = useMemo(() => {
    if (!value) return null
    return (
      allModels.find(
        m => m.name === value.name && m.namespace === value.namespace && m.type === value.type
      ) ?? null
    )
  }, [allModels, value])

  const selectedDisplayModel = useMemo<UnifiedModel | null>(() => {
    if (selectedModel) return selectedModel
    if (!value) return null
    return {
      name: value.name,
      namespace: value.namespace,
      type: value.type,
    } as UnifiedModel
  }, [selectedModel, value])

  const displayValue = useMemo(() => {
    if (selectedModel) return selectedModel.displayName || selectedModel.name
    if (value) return value.name
    return t('document.multimodal.selectModel')
  }, [selectedModel, value, t])

  const handleSelect = (model: UnifiedModel) => {
    onChange({
      name: model.name,
      namespace: model.namespace || 'default',
      type: model.type,
    })
  }

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'public':
        return t('common:models.public')
      case 'user':
        return t('common:models.my_models')
      case 'group':
        return t('common:models.group')
      default:
        return type
    }
  }

  const cascadeLabels: ModelCascadeLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
      searchPlaceholder: t('common:models.search_models', 'Search models or groups...'),
      searchResults: t('common:models.search_results', 'Search results'),
      noModels: loading
        ? t('common:loading', 'Loading...')
        : t('document.multimodal.noMultimodalModel'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [loading, t]
  )

  return (
    <div className="flex flex-col gap-1">
      <GroupedModelSelect
        models={allModels}
        selectedModel={selectedDisplayModel}
        labels={cascadeLabels}
        onSelectModel={handleSelect}
        placeholder={loading ? t('common:loading', 'Loading...') : displayValue}
        disabled={disabled || loading}
        dataTestId="multimodal-analysis-model-select"
        triggerClassName={error ? 'border-red-500' : undefined}
        getModelKey={model => `${model.type}-${model.namespace}-${model.name}`}
        renderModelBadges={model => (
          <Badge variant="secondary" size="sm" className="shrink-0">
            {getTypeLabel(model.type)}
          </Badge>
        )}
        renderModelMeta={model =>
          model.modelId ? (
            <span className="block truncate text-xs text-text-muted">{model.modelId}</span>
          ) : null
        }
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  )
}
