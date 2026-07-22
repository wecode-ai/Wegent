// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ModelSelector Component
 *
 * A component for displaying and selecting AI models.
 * Supports two usage patterns:
 *
 * 1. Legacy mode (backward compatible): Pass selectedModel, setSelectedModel, etc.
 *    The component will use useModelSelection hook internally.
 *
 * 2. New mode: Use useModelSelection hook externally and pass the returned values.
 *
 * This design allows gradual migration from the old API to the new API.
 */

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { ChevronDown, ImageIcon, Info, Video } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { ModelIcon } from '@/components/icons/ModelIcon'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { Tag } from '@/components/ui/tag'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import {
  ModelCascadeContent,
  type ModelCascadeLabels,
  type SpecialModelOption,
} from '@/components/model-select/ModelCascadeSelect'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useModelSelection } from '@/features/tasks/hooks/useModelSelection'
import type { Team, BotSummary } from '@/types/api'
import type { ModelCategoryType } from '@/apis/models'

// Re-export types and constants from useModelSelection for backward compatibility
export {
  DEFAULT_MODEL_NAME,
  allBotsHavePredefinedModel,
} from '@/features/tasks/hooks/useModelSelection'
export type {
  Model,
  ModelRegion,
  ModelCategoryType,
} from '@/features/tasks/hooks/useModelSelection'

import type { Model } from '@/features/tasks/hooks/useModelSelection'
import { DEFAULT_MODEL_NAME } from '@/features/tasks/hooks/useModelSelection'
import { ModelDetailsBody, ModelDetailsDialog } from './ModelDetailsDialog'

// ============================================================================
// Types
// ============================================================================

/** Extended Team type with bot details */
export interface TeamWithBotDetails extends Team {
  bots: Array<{
    bot_id: number
    bot_prompt: string
    role?: string
    bot?: BotSummary
  }>
}

/** Legacy props interface (backward compatible) */
export interface ModelSelectorProps {
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride?: boolean
  setForceOverride?: (force: boolean) => void
  selectedTeam: TeamWithBotDetails | null
  disabled: boolean
  isLoading?: boolean
  /** When true, display only icon without text (for responsive collapse) */
  compact?: boolean
  /** Current team ID for model preference storage */
  teamId?: number | null
  /** Current task ID for session-level model preference storage (null for new chat) */
  taskId?: number | null
  /** Task's model_id from backend - used as fallback when no session preference exists */
  taskModelId?: string | null
  /** Initial force override value when restoring a persisted non-task selection */
  initialForceOverride?: boolean
  /** Model category type for filtering and display (default: 'llm') */
  modelCategoryType?: ModelCategoryType
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Get unique key for model (name + type) */
function getModelKey(model: Model): string {
  return `${model.name}:${model.type || ''}`
}

/** Get a stable sync key for comparing models across component boundaries */
function getModelSyncKey(model: Model | null): string | null {
  return model ? getModelKey(model) : null
}

function hasModelDetails(model: Model): boolean {
  const capabilities = model.modelCapabilities ?? model.config?.modelCapabilities
  const supportsMedia =
    capabilities !== null &&
    typeof capabilities === 'object' &&
    ('supportsImage' in capabilities || 'supportsVideo' in capabilities)

  return (
    model.costIndex != null ||
    model.contextWindow != null ||
    model.maxOutputTokens != null ||
    supportsMedia
  )
}

interface ModelInformationActionProps {
  model: Model
  label: string
  isMobile: boolean
  unavailableLabel: string
  onOpenDetails: (model: Model) => void
}

function ModelInformationAction({
  model,
  label,
  isMobile,
  unavailableLabel,
  onOpenDetails,
}: ModelInformationActionProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const button = (
    <button
      type="button"
      data-testid={`model-info-${model.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
      aria-label={label}
      title={label}
      onClick={isMobile ? () => onOpenDetails(model) : undefined}
      className="flex min-h-[44px] w-10 shrink-0 self-stretch items-center justify-center text-text-muted transition-colors hover:bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-0"
    >
      <Info className="h-4 w-4" aria-hidden="true" />
    </button>
  )

  if (isMobile) return button

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={8}
          data-testid="model-details-preview"
          className="w-[420px] max-w-[calc(100vw-32px)] rounded-lg bg-base p-5 text-text-primary"
        >
          <div className="mb-4">
            <div className="truncate text-lg font-semibold">{model.displayName || model.name}</div>
            <div className="mt-1 truncate text-sm text-text-muted">
              {model.modelId || unavailableLabel}
            </div>
          </div>
          <ModelDetailsBody model={model} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ============================================================================
// Component
// ============================================================================

export default function ModelSelector({
  selectedModel: externalSelectedModel,
  setSelectedModel: externalSetSelectedModel,
  forceOverride: externalForceOverride = false,
  setForceOverride: externalSetForceOverride = () => {},
  selectedTeam,
  disabled,
  isLoading: externalLoading,
  compact = false,
  teamId,
  taskId,
  taskModelId,
  initialForceOverride,
  modelCategoryType = 'llm',
}: ModelSelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const externalModelKey = getModelSyncKey(externalSelectedModel)

  // Use the centralized model selection hook
  const modelSelection = useModelSelection({
    teamId: teamId ?? null,
    taskId: taskId ?? null,
    taskModelId,
    initialForceOverride,
    selectedTeam,
    disabled,
    modelCategoryType,
  })
  const {
    selectedModel: internalSelectedModel,
    forceOverride: internalForceOverride,
    selectModel: selectInternalModel,
    setForceOverride: setInternalForceOverride,
    showAdvancedModels,
    setShowAdvancedModels,
  } = modelSelection

  // Get icon based on model category type
  const IconComponent = useMemo(() => {
    switch (modelCategoryType) {
      case 'video':
        return Video
      case 'image':
        return ImageIcon
      default:
        return ModelIcon
    }
  }, [modelCategoryType])

  const internalModelKey = getModelSyncKey(internalSelectedModel)

  // Sync selected model between external props and internal hook state.
  // Only the side that changed in this render cycle is allowed to drive the other side,
  // which prevents parent/child ping-pong updates when the model objects differ by reference.
  const prevExternalModelKeyRef = React.useRef<string | null>(externalModelKey)
  const prevInternalModelKeyRef = React.useRef<string | null>(internalModelKey)
  const hasSyncedModelRef = React.useRef(false)

  useEffect(() => {
    const previousExternalModelKey = prevExternalModelKeyRef.current
    const previousInternalModelKey = prevInternalModelKeyRef.current
    const externalModelChanged = hasSyncedModelRef.current
      ? previousExternalModelKey !== externalModelKey
      : externalSelectedModel !== null
    const internalModelChanged = hasSyncedModelRef.current
      ? previousInternalModelKey !== internalModelKey
      : false

    prevExternalModelKeyRef.current = externalModelKey
    prevInternalModelKeyRef.current = internalModelKey
    hasSyncedModelRef.current = true

    if (externalModelChanged) {
      if (externalSelectedModel && externalModelKey !== internalModelKey) {
        selectInternalModel(externalSelectedModel)
      } else if (!externalSelectedModel && previousExternalModelKey !== null && internalModelKey) {
        selectInternalModel(null)
      }
      return
    }

    if (internalModelChanged && internalSelectedModel && internalModelKey !== externalModelKey) {
      externalSetSelectedModel(internalSelectedModel)
    }
  }, [
    externalModelKey,
    externalSelectedModel,
    internalModelKey,
    internalSelectedModel,
    selectInternalModel,
    externalSetSelectedModel,
  ])

  // Apply the same one-direction-per-change rule for forceOverride to avoid update loops.
  const prevExternalForceOverrideRef = React.useRef(externalForceOverride)
  const prevInternalForceOverrideRef = React.useRef(internalForceOverride)
  const hasSyncedForceOverrideRef = React.useRef(false)

  useEffect(() => {
    const previousExternalForceOverride = prevExternalForceOverrideRef.current
    const previousInternalForceOverride = prevInternalForceOverrideRef.current
    const externalForceOverrideChanged = hasSyncedForceOverrideRef.current
      ? previousExternalForceOverride !== externalForceOverride
      : externalForceOverride
    const internalForceOverrideChanged = hasSyncedForceOverrideRef.current
      ? previousInternalForceOverride !== internalForceOverride
      : false

    prevExternalForceOverrideRef.current = externalForceOverride
    prevInternalForceOverrideRef.current = internalForceOverride
    hasSyncedForceOverrideRef.current = true

    if (externalForceOverrideChanged) {
      if (externalForceOverride !== internalForceOverride) {
        setInternalForceOverride(externalForceOverride)
      }
      return
    }

    if (internalForceOverrideChanged && internalForceOverride !== externalForceOverride) {
      externalSetForceOverride(internalForceOverride)
    }
  }, [
    externalForceOverride,
    internalForceOverride,
    setInternalForceOverride,
    externalSetForceOverride,
  ])

  // Local UI state
  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const [inspectedModel, setInspectedModel] = useState<Model | null>(null)

  // Reset search when popover closes
  useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
    }
  }, [isOpen])

  const selectedCascadeModel =
    modelSelection.selectedModel?.name === DEFAULT_MODEL_NAME
      ? modelSelection.boundDefaultModel
      : modelSelection.selectedModel

  const selectedModelIsAdvanced = selectedCascadeModel?.isAdvanced === true

  useEffect(() => {
    if (isOpen && selectedModelIsAdvanced && !showAdvancedModels) {
      setShowAdvancedModels(true)
    }
  }, [isOpen, selectedModelIsAdvanced, showAdvancedModels, setShowAdvancedModels])

  // Determine if selector should be disabled
  const isDisabled =
    disabled || externalLoading || modelSelection.isLoading || modelSelection.isMixedTeam

  // Handle model selection
  const handleModelSelect = (model: Model) => {
    modelSelection.selectModel(model)
    setIsOpen(false)
  }

  const handleSpecialOptionSelect = (key: string) => {
    if (key === DEFAULT_MODEL_NAME) {
      modelSelection.selectDefaultModel()
    }
    setIsOpen(false)
  }

  const cascadeLabels: ModelCascadeLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
      searchPlaceholder: t('common:models.search_models', 'Search models or groups...'),
      searchResults: t('common:models.search_results', 'Search results'),
      noModels: t('common:models.no_models', 'No models available'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [t]
  )

  const specialOptions: SpecialModelOption[] = useMemo(() => {
    if (!modelSelection.showDefaultOption) return []
    return [
      {
        key: DEFAULT_MODEL_NAME,
        label: t('common:task_submit.default_model', 'Default model'),
        description: t('common:task_submit.use_bot_model', 'Use Bot preset model'),
      },
    ]
  }, [modelSelection.showDefaultOption, t])

  // Tooltip content for model selector
  const tooltipContent =
    compact && modelSelection.selectedModel
      ? `${t('common:task_submit.model_tooltip', '选择用于对话的 AI 模型')}: ${modelSelection.getDisplayText()}`
      : t('common:task_submit.model_tooltip', '选择用于对话的 AI 模型')

  return (
    <div
      className="flex items-center min-w-0"
      style={{ maxWidth: compact ? 'auto' : isMobile ? 200 : 260 }}
    >
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  role="combobox"
                  aria-expanded={isOpen}
                  aria-controls="model-selector-popover"
                  disabled={isDisabled}
                  data-testid="model-selector"
                  className={cn(
                    'flex items-center gap-1 min-w-0 rounded-[24px] pl-2.5 pr-3 py-2.5 h-9',
                    'transition-colors',
                    modelSelection.isModelRequired
                      ? 'border border-error text-error bg-error/5 hover:bg-error/10'
                      : 'bg-transparent text-text-primary hover:bg-hover',
                    modelSelection.isLoading || externalLoading ? 'animate-pulse' : '',
                    'focus:outline-none focus:ring-0',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  <IconComponent className="h-4 w-4 flex-shrink-0" />
                  {!compact && (
                    <span className="truncate text-xs min-w-0">
                      {modelSelection.getDisplayText()}
                    </span>
                  )}
                  <ChevronDown className="h-2.5 w-2.5 flex-shrink-0 opacity-60" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{tooltipContent}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <PopoverContent
          className={cn(
            'p-0 w-auto border border-border bg-base',
            'shadow-xl rounded-xl overflow-hidden',
            'max-h-[var(--radix-popover-content-available-height,400px)]',
            'flex flex-col'
          )}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          avoidCollisions={true}
          sticky="partial"
        >
          {modelSelection.error ? (
            <div className="w-[min(760px,calc(100vw-32px))] px-4 py-8 text-center text-sm text-error">
              {modelSelection.error}
            </div>
          ) : (
            <ModelCascadeContent
              models={modelSelection.filteredModels}
              selectedModel={selectedCascadeModel}
              selectedSpecialKey={
                modelSelection.selectedModel?.name === DEFAULT_MODEL_NAME
                  ? DEFAULT_MODEL_NAME
                  : null
              }
              specialOptions={specialOptions}
              labels={cascadeLabels}
              searchValue={searchValue}
              onSearchValueChange={setSearchValue}
              onSelectModel={handleModelSelect}
              onSelectSpecialOption={handleSpecialOptionSelect}
              getModelKey={getModelKey}
              renderModelBadges={model => (
                <>
                  {model.isAdvanced && (
                    <Tag
                      variant="warning"
                      data-testid="model-advanced-badge"
                      className="text-[10px] flex-shrink-0 whitespace-nowrap"
                    >
                      {t('common:models.advanced', 'Advanced')}
                    </Tag>
                  )}
                  {model.type === 'user' && (
                    <Tag variant="info" className="text-[10px] flex-shrink-0 whitespace-nowrap">
                      {t('common:settings.personal', 'Personal')}
                    </Tag>
                  )}
                </>
              )}
              renderModelMeta={model =>
                model.modelId ? (
                  <span className="block truncate text-xs text-text-muted" title={model.modelId}>
                    {model.modelId}
                  </span>
                ) : null
              }
              renderModelActions={model => {
                if (modelCategoryType !== 'llm' || !hasModelDetails(model)) return null

                const label = `${t('common:models.view_details')}：${
                  model.displayName || model.name
                }`
                return (
                  <ModelInformationAction
                    model={model}
                    label={label}
                    isMobile={isMobile}
                    unavailableLabel={t('common:models.details_unavailable')}
                    onOpenDetails={setInspectedModel}
                  />
                )
              }}
              footer={
                <div
                  data-testid="model-selector-footer"
                  className="flex items-center justify-between gap-2 px-3 py-2.5"
                >
                  <button
                    type="button"
                    data-testid="model-settings-button"
                    className="group -ml-1 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-hover"
                    onClick={() => router.push(paths.settings.models.getHref())}
                  >
                    <Cog6ToothIcon className="h-4 w-4 text-text-secondary group-hover:text-text-primary" />
                    <span className="text-xs text-text-secondary group-hover:text-text-primary">
                      {t('common:models.manage', 'Model settings')}
                    </span>
                  </button>
                  {modelSelection.hasAdvancedModels && (
                    <label
                      htmlFor="show-advanced-models-dropdown"
                      data-testid="show-advanced-models-toggle"
                      className="ml-auto flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-hover"
                    >
                      <Checkbox
                        id="show-advanced-models-dropdown"
                        checked={modelSelection.showAdvancedModels}
                        onCheckedChange={(checked: boolean | 'indeterminate') =>
                          modelSelection.setShowAdvancedModels(checked === true)
                        }
                        className="h-4 w-4"
                      />
                      <span className="text-xs text-text-secondary">
                        {t('common:task_submit.show_advanced_models', 'Show advanced models')}
                      </span>
                    </label>
                  )}
                </div>
              }
            />
          )}
        </PopoverContent>
      </Popover>
      <ModelDetailsDialog
        model={inspectedModel}
        onOpenChange={open => {
          if (!open) setInspectedModel(null)
        }}
      />
    </div>
  )
}
