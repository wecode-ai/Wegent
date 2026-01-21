// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { useModelSelection, type Model } from '../../hooks/useModelSelection'
import type { Team } from '@/types/api'
import { cn } from '@/lib/utils'
import { Globe, User } from 'lucide-react'

export interface RegenerateModelPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedTeam: Team | null
  onSelectModel: (model: Model) => void
  isLoading?: boolean
  trigger: React.ReactNode
  /** Tooltip text for the trigger button */
  tooltipText?: string
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
}: RegenerateModelPopoverProps) {
  const { t } = useTranslation('chat')

  // Use the model selection hook to get filtered models
  const {
    filteredModels,
    isLoading: isModelsLoading,
    getModelDisplayText,
  } = useModelSelection({
    teamId: selectedTeam?.id ?? null,
    taskId: null,
    selectedTeam,
  })

  const handleModelSelect = (model: Model) => {
    onSelectModel(model)
    onOpenChange(false)
  }

  const loading = isLoading || isModelsLoading

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
        className="w-64 p-2"
        onInteractOutside={() => onOpenChange(false)}
      >
        {/* Header */}
        <div className="px-2 py-1.5 mb-1">
          <h4 className="text-sm font-medium text-text-primary">{t('regenerate.select_model')}</h4>
          <p className="text-xs text-text-muted mt-0.5">{t('regenerate.select_model_desc')}</p>
        </div>

        {/* Model list */}
        <div className="max-h-60 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="text-center text-sm text-text-muted py-4">
              {t('correction.no_models')}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredModels.map(model => {
                const isPublic = model.type === 'public'
                const displayName = getModelDisplayText(model)

                return (
                  <button
                    type="button"
                    key={`${model.name}:${model.type || ''}`}
                    onClick={() => handleModelSelect(model)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-2 rounded-md text-left',
                      'hover:bg-fill-sec transition-colors',
                      'focus:outline-none focus:ring-2 focus:ring-primary/20'
                    )}
                  >
                    {/* Model type icon */}
                    <span className="flex-shrink-0">
                      {isPublic ? (
                        <Globe className="h-3.5 w-3.5 text-text-muted" />
                      ) : (
                        <User className="h-3.5 w-3.5 text-text-muted" />
                      )}
                    </span>

                    {/* Model name */}
                    <span className="flex-1 text-sm text-text-primary truncate">{displayName}</span>

                    {/* Model type badge */}
                    <span
                      className={cn(
                        'text-xs px-1.5 py-0.5 rounded',
                        isPublic
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                      )}
                    >
                      {isPublic ? t('correction.public_model') : t('correction.user_model')}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default RegenerateModelPopover
