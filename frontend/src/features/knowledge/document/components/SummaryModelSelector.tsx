// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  GroupedModelSelect,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import { modelApis, UnifiedModel } from '@/apis/models'
import { useTranslation } from '@/hooks/useTranslation'
import { getGlobalModelPreference } from '@/utils/modelPreferences'
import type { SummaryModelRef } from '@/types/knowledge'

interface SummaryModelSelectorProps {
  value?: SummaryModelRef | null
  onChange: (value: SummaryModelRef | null) => void
  disabled?: boolean
  error?: string
  /** Optional team ID to read cached model preference from localStorage */
  knowledgeDefaultTeamId?: number | null
  /** Optional bind model name from team's bot config as fallback */
  bindModel?: string | null
}

export function SummaryModelSelector({
  value,
  onChange,
  disabled = false,
  error,
  knowledgeDefaultTeamId,
  bindModel,
}: SummaryModelSelectorProps) {
  const { t } = useTranslation('knowledge')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(false)
  // Track the last team ID for which we attempted preselection
  // This allows re-attempting when the team ID changes or dialog reopens
  // ATTEMPTED_WITHOUT_TEAM (-1) is a sentinel value indicating we attempted
  // preselection before team info was loaded, allowing re-attempt when team info arrives
  const ATTEMPTED_WITHOUT_TEAM = -1
  const attemptedTeamIdRef = useRef<number | null | typeof ATTEMPTED_WITHOUT_TEAM>(null)

  // Fetch models on mount
  useEffect(() => {
    const fetchModels = async () => {
      setLoading(true)
      try {
        // Fetch LLM models (all scopes)
        const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm')
        // Sort by displayName
        const sortedModels = (response.data || []).sort((a, b) => {
          const nameA = a.displayName || a.name
          const nameB = b.displayName || b.name
          return nameA.localeCompare(nameB)
        })
        setModels(sortedModels)
      } catch (err) {
        console.error('Failed to fetch models:', err)
        setModels([])
      } finally {
        setLoading(false)
      }
    }

    fetchModels()
  }, [])

  // Auto-preselect model with priority:
  // 1. Cached preference from localStorage
  // 2. Team's bind_model from bot config
  // 3. First available model in the list
  //
  // Conditions:
  // - Models are loaded
  // - No value is currently selected
  // - Valid knowledgeDefaultTeamId is provided (for cache and tracking)
  // - Haven't attempted preselection for this team ID yet
  useEffect(() => {
    // Skip if value exists, still loading
    if (value || loading || models.length === 0) {
      return
    }

    // Determine if we should attempt preselection
    // - First attempt: attemptedTeamIdRef.current is null
    // - Re-attempt: previously attempted without team info (-1), now have teamId
    // - Re-attempt: teamId changed to a different value
    const shouldAttempt = () => {
      if (attemptedTeamIdRef.current === null) return true
      if (attemptedTeamIdRef.current === ATTEMPTED_WITHOUT_TEAM && knowledgeDefaultTeamId)
        return true
      if (knowledgeDefaultTeamId && attemptedTeamIdRef.current !== knowledgeDefaultTeamId)
        return true
      return false
    }

    if (!shouldAttempt()) return

    // Mark this team ID as attempted
    // Use sentinel value (-1) when team info is not yet loaded, so we can re-attempt when it arrives
    attemptedTeamIdRef.current = knowledgeDefaultTeamId ?? ATTEMPTED_WITHOUT_TEAM

    // Priority 1: Try cached preference from localStorage
    if (knowledgeDefaultTeamId) {
      const cachedPreference = getGlobalModelPreference(knowledgeDefaultTeamId)

      if (cachedPreference?.modelName) {
        const matchedModel = models.find(model => {
          if (model.name !== cachedPreference.modelName) {
            return false
          }
          if (cachedPreference.modelType && model.type !== cachedPreference.modelType) {
            return false
          }
          return true
        })

        if (matchedModel) {
          onChange({
            name: matchedModel.name,
            namespace: matchedModel.namespace || 'default',
            type: matchedModel.type,
          })
          return
        }
      }
    }

    // Priority 2: Try team's bind_model from bot config
    if (bindModel) {
      const matchedModel = models.find(
        model => model.name === bindModel || model.displayName === bindModel
      )
      if (matchedModel) {
        onChange({
          name: matchedModel.name,
          namespace: matchedModel.namespace || 'default',
          type: matchedModel.type,
        })
        return
      }
    }

    // Priority 3: Select the first available model
    const firstModel = models[0]
    if (firstModel) {
      onChange({
        name: firstModel.name,
        namespace: firstModel.namespace || 'default',
        type: firstModel.type,
      })
    }
  }, [models, value, loading, knowledgeDefaultTeamId, bindModel, onChange])

  // Find selected model
  const selectedModel = useMemo(() => {
    if (!value) return null
    return models.find(
      m => m.name === value.name && m.namespace === value.namespace && m.type === value.type
    )
  }, [models, value])

  const selectedDisplayModel = useMemo(() => {
    if (selectedModel) return selectedModel
    if (!value) return null
    return {
      name: value.name,
      namespace: value.namespace,
      type: value.type,
    } as UnifiedModel
  }, [selectedModel, value])

  // Get display value
  const displayValue = useMemo(() => {
    if (selectedModel) {
      return selectedModel.displayName || selectedModel.name
    }
    if (value) {
      // Model not found in list but value exists
      return value.name
    }
    return t('document.summary.selectModel')
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
        : t('common:models.no_models', 'No models available'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [loading, t]
  )

  return (
    <div className="flex flex-col gap-1">
      <GroupedModelSelect
        models={models}
        selectedModel={selectedDisplayModel}
        labels={cascadeLabels}
        onSelectModel={handleSelect}
        placeholder={loading ? t('common:loading', 'Loading...') : displayValue}
        disabled={disabled || loading}
        dataTestId="summary-model-select"
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
