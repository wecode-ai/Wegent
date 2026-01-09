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

import React, { useState, useEffect } from 'react'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { Check, Brain, ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { Tag } from '@/components/ui/tag'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useModelSelection } from '@/features/tasks/hooks/useModelSelection'
import type { Team, BotSummary } from '@/types/api'

// Re-export types and constants from useModelSelection for backward compatibility
export {
  DEFAULT_MODEL_NAME,
  allBotsHavePredefinedModel,
} from '@/features/tasks/hooks/useModelSelection'
export type { Model, ModelRegion } from '@/features/tasks/hooks/useModelSelection'

import type { Model } from '@/features/tasks/hooks/useModelSelection'
import { DEFAULT_MODEL_NAME } from '@/features/tasks/hooks/useModelSelection'

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
  forceOverride: boolean
  setForceOverride: (force: boolean) => void
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
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Get display text for a model: displayName or name */
function getModelDisplayText(model: Model): string {
  return model.displayName || model.name
}

/** Get unique key for model (name + type) */
function getModelKey(model: Model): string {
  return `${model.name}:${model.type || ''}`
}

// ============================================================================
// Component
// ============================================================================

export default function ModelSelector({
  selectedModel: externalSelectedModel,
  setSelectedModel: externalSetSelectedModel,
  forceOverride: externalForceOverride,
  setForceOverride: externalSetForceOverride,
  selectedTeam,
  disabled,
  isLoading: externalLoading,
  compact = false,
  teamId,
  taskId,
  taskModelId,
}: ModelSelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const isMobile = useMediaQuery('(max-width: 767px)')

  // Use the centralized model selection hook
  const modelSelection = useModelSelection({
    teamId: teamId ?? null,
    taskId: taskId ?? null,
    taskModelId,
    selectedTeam,
    disabled,
  })

  // Sync external state with internal hook state
  // This allows the component to work with both legacy and new APIs
  useEffect(() => {
    if (modelSelection.selectedModel !== externalSelectedModel) {
      if (modelSelection.selectedModel) {
        externalSetSelectedModel(modelSelection.selectedModel)
      }
    }
  }, [modelSelection.selectedModel, externalSelectedModel, externalSetSelectedModel])

  useEffect(() => {
    if (modelSelection.forceOverride !== externalForceOverride) {
      externalSetForceOverride(modelSelection.forceOverride)
    }
  }, [modelSelection.forceOverride, externalForceOverride, externalSetForceOverride])

  // Local UI state
  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')

  // Reset search when popover closes
  useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
    }
  }, [isOpen])

  // Scroll to selected model when popover opens
  useEffect(() => {
    if (isOpen && modelSelection.selectedModel) {
      // Delay to ensure the popover content is rendered
      const timer = setTimeout(() => {
        const selectedKey =
          modelSelection.selectedModel?.name === DEFAULT_MODEL_NAME
            ? DEFAULT_MODEL_NAME
            : getModelKey(modelSelection.selectedModel!)

        // Find the element by data attribute
        const selectedElement = document.querySelector(
          `[data-model-key="${selectedKey}"]`
        ) as HTMLElement

        if (selectedElement) {
          // Find the scroll container (CommandList)
          const scrollContainer = selectedElement.closest('[cmdk-list]') as HTMLElement
          if (scrollContainer) {
            // Calculate position to center the selected item
            const containerHeight = scrollContainer.clientHeight
            const itemTop = selectedElement.offsetTop
            const itemHeight = selectedElement.offsetHeight
            scrollContainer.scrollTop = itemTop - containerHeight / 2 + itemHeight / 2
          }
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isOpen, modelSelection.selectedModel])

  // Determine if selector should be disabled
  const isDisabled =
    disabled || externalLoading || modelSelection.isLoading || modelSelection.isMixedTeam

  // Handle model selection
  const handleModelSelect = (value: string) => {
    modelSelection.selectModelByKey(value)
    setIsOpen(false)
  }

  // Handle force override checkbox
  const handleForceOverrideChange = (checked: boolean | 'indeterminate') => {
    modelSelection.setForceOverride(checked === true)
  }

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
                  className={cn(
                    'flex items-center gap-1 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
                    'border transition-colors',
                    modelSelection.isModelRequired
                      ? 'border-error text-error bg-error/5 hover:bg-error/10'
                      : 'border-border bg-base text-text-primary hover:bg-hover',
                    modelSelection.isLoading || externalLoading ? 'animate-pulse' : '',
                    'focus:outline-none focus:ring-0',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  <Brain className="h-4 w-4 flex-shrink-0" />
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
            'p-0 w-auto min-w-[280px] max-w-[320px] border border-border bg-base',
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
          <Command
            className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden"
            value={
              modelSelection.selectedModel
                ? modelSelection.selectedModel.name === DEFAULT_MODEL_NAME
                  ? `${DEFAULT_MODEL_NAME} ${t('common:task_submit.default_model', '默认')} ${t('common:task_submit.use_bot_model', '使用 Bot 预设模型')}`
                  : `${modelSelection.selectedModel.name} ${modelSelection.selectedModel.displayName || ''} ${modelSelection.selectedModel.provider} ${modelSelection.selectedModel.modelId} ${modelSelection.selectedModel.type}`
                : undefined
            }
          >
            <CommandInput
              placeholder={t('common:task_submit.search_model', '搜索模型...')}
              value={searchValue}
              onValueChange={setSearchValue}
              className={cn(
                'h-9 rounded-none border-b border-border flex-shrink-0',
                'placeholder:text-text-muted text-sm'
              )}
            />
            <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
              {modelSelection.error ? (
                <div className="py-4 px-3 text-center text-sm text-error">
                  {modelSelection.error}
                </div>
              ) : modelSelection.filteredModels.length === 0 ? (
                <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                  {modelSelection.isLoading ? 'Loading...' : t('common:models.no_models')}
                </CommandEmpty>
              ) : (
                <>
                  <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                    {t('common:branches.no_match')}
                  </CommandEmpty>
                  <CommandGroup>
                    {/* Default option - only show when all bots have predefined models */}
                    {modelSelection.showDefaultOption && (
                      <CommandItem
                        key={DEFAULT_MODEL_NAME}
                        value={`${DEFAULT_MODEL_NAME} ${t('common:task_submit.default_model', '默认')} ${t('common:task_submit.use_bot_model', '使用 Bot 预设模型')}`}
                        onSelect={() => handleModelSelect(DEFAULT_MODEL_NAME)}
                        data-model-key={DEFAULT_MODEL_NAME}
                        className={cn(
                          'group cursor-pointer select-none',
                          'px-3 py-2 text-sm text-text-primary',
                          'rounded-md mx-1 my-[2px]',
                          'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                          'aria-selected:bg-hover',
                          '!flex !flex-row !items-center !justify-between !gap-2'
                        )}
                      >
                        <div className="flex flex-col min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium text-sm text-text-primary">
                              {t('common:task_submit.default_model', '默认模型')}
                            </span>
                            <Tag
                              variant="info"
                              className="text-[10px] flex-shrink-0 whitespace-nowrap"
                            >
                              {t('common:models.public', '公共')}
                            </Tag>
                          </div>
                          <span className="text-xs text-text-muted">
                            {t('common:task_submit.use_bot_model', '使用Bot预设模型')}
                          </span>
                        </div>
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            modelSelection.selectedModel?.name === DEFAULT_MODEL_NAME
                              ? 'opacity-100 text-primary'
                              : 'opacity-0'
                          )}
                        />
                      </CommandItem>
                    )}
                    {modelSelection.filteredModels.map(model => (
                      <CommandItem
                        key={getModelKey(model)}
                        value={`${model.name} ${model.displayName || ''} ${model.provider} ${model.modelId} ${model.type}`}
                        onSelect={() => handleModelSelect(getModelKey(model))}
                        data-model-key={getModelKey(model)}
                        className={cn(
                          'group cursor-pointer select-none',
                          'px-3 py-2 text-sm text-text-primary',
                          'rounded-md mx-1 my-[2px]',
                          'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                          'aria-selected:bg-hover',
                          '!flex !flex-row !items-center !justify-between !gap-2'
                        )}
                      >
                        <div className="flex flex-col min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span
                              className="font-medium text-sm text-text-primary truncate min-w-0"
                              title={getModelDisplayText(model)}
                            >
                              {getModelDisplayText(model)}
                            </span>
                            {model.type === 'public' && (
                              <Tag
                                variant="info"
                                className="text-[10px] flex-shrink-0 whitespace-nowrap"
                              >
                                {t('common:models.public', '公共')}
                              </Tag>
                            )}
                          </div>
                          {model.modelId && (
                            <span
                              className="text-xs text-text-muted truncate"
                              title={model.modelId}
                            >
                              {model.modelId}
                            </span>
                          )}
                        </div>
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            modelSelection.selectedModel?.name === model.name &&
                              modelSelection.selectedModel?.type === model.type
                              ? 'opacity-100 text-primary'
                              : 'opacity-0'
                          )}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
            {/* Footer options - override and settings */}
            <div className="border-t border-border">
              {/* Force override checkbox - always show when model is selected */}
              {modelSelection.selectedModel && !modelSelection.isMixedTeam && (
                <div
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-hover transition-colors duration-150"
                  onClick={e => {
                    e.stopPropagation()
                    handleForceOverrideChange(!modelSelection.forceOverride)
                  }}
                >
                  <Checkbox
                    id="force-override-model-dropdown"
                    checked={modelSelection.forceOverride}
                    onCheckedChange={handleForceOverrideChange}
                    disabled={disabled || externalLoading}
                    className="h-4 w-4"
                  />
                  <span className="text-xs text-text-secondary">
                    {t('common:task_submit.override_default_model', '覆盖默认模型')}
                  </span>
                </div>
              )}
              {/* Model Settings Link */}
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer group hover:bg-hover transition-colors duration-150"
                onClick={() => router.push(paths.settings.models.getHref())}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    router.push(paths.settings.models.getHref())
                  }
                }}
              >
                <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="text-xs text-text-secondary group-hover:text-text-primary">
                  {t('common:models.manage', '模型设置')}
                </span>
              </div>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
