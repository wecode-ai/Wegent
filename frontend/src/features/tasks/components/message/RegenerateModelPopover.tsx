// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { useModelSelection, type Model } from '../../hooks/useModelSelection'
import type { Team, TaskType } from '@/types/api'
import type { ModelCategoryType } from '@/apis/models'
import {
  ModelCascadeContent,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'

/**
 * Maps task type to the corresponding model category type.
 * This ensures the regenerate model popover shows the correct model list
 * based on the current task type (e.g., image task shows image models).
 */
function getModelCategoryFromTaskType(taskType?: TaskType): ModelCategoryType {
  switch (taskType) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    default:
      return 'llm'
  }
}

export interface RegenerateModelPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedTeam: Team | null
  onSelectModel: (model: Model) => void
  isLoading?: boolean
  trigger: React.ReactNode
  /** Tooltip text for the trigger button */
  tooltipText?: string
  /** Current task type to determine which model category to show */
  taskType?: TaskType
}

/**
 * A popover component for selecting a model when regenerating AI responses.
 * Shows a list of compatible models based on the current team's agent type.
 */
export function RegenerateModelPopover({
  open,
  onOpenChange,
  selectedTeam,
  onSelectModel,
  isLoading = false,
  trigger,
  tooltipText,
  taskType,
}: RegenerateModelPopoverProps) {
  const { t } = useTranslation('chat')
  const [searchValue, setSearchValue] = useState('')

  // Determine model category based on task type
  const modelCategoryType = getModelCategoryFromTaskType(taskType)

  // Use the model selection hook to get filtered models
  const { filteredModels, isLoading: isModelsLoading } = useModelSelection({
    teamId: selectedTeam?.id ?? null,
    taskId: null,
    selectedTeam,
    modelCategoryType,
  })

  const handleModelSelect = (model: Model) => {
    onSelectModel(model)
    onOpenChange(false)
    setSearchValue('')
  }

  const loading = isLoading || isModelsLoading
  const cascadeLabels: ModelCascadeLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
      searchPlaceholder: t('common:models.search_models', 'Search models or groups...'),
      searchResults: t('common:models.search_results', 'Search results'),
      noModels: t('correction.no_models'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [t]
  )

  // Wrap trigger with Tooltip inside Popover to avoid asChild conflicts
  // The Tooltip wraps the PopoverTrigger so hover events work correctly
  const triggerWithTooltip = tooltipText ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  ) : (
    <PopoverTrigger asChild>{trigger}</PopoverTrigger>
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {triggerWithTooltip}
      <PopoverContent
        side="top"
        align="start"
        className="w-auto overflow-hidden rounded-xl border border-border p-0 shadow-xl"
        onInteractOutside={() => onOpenChange(false)}
      >
        <div className="border-b border-border px-3 py-2">
          <h4 className="text-sm font-medium text-text-primary">{t('regenerate.select_model')}</h4>
          <p className="text-xs text-text-muted mt-0.5">{t('regenerate.select_model_desc')}</p>
        </div>
        {loading ? (
          <div className="flex w-[min(640px,calc(100vw-32px))] items-center justify-center py-8">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <ModelCascadeContent
            models={filteredModels}
            labels={cascadeLabels}
            searchValue={searchValue}
            onSearchValueChange={setSearchValue}
            onSelectModel={handleModelSelect}
            getModelKey={model => `${model.name}:${model.type || ''}`}
            className="w-[min(640px,calc(100vw-32px))]"
            renderModelBadges={model => (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                {model.type === 'public'
                  ? t('correction.public_model')
                  : t('correction.user_model')}
              </span>
            )}
            renderModelMeta={model =>
              model.modelId ? (
                <span className="block truncate text-xs text-text-muted">{model.modelId}</span>
              ) : null
            }
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

export default RegenerateModelPopover
