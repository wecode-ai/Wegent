// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * VideoModelSelector Component
 *
 * A component for selecting video generation models.
 * Uses Popover + Command for search and selection functionality.
 */

'use client'

import React, { useState } from 'react'
import { Video, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Tag } from '@/components/ui/tag'
import type { Model } from '../../hooks/useModelSelection'

export interface VideoModelSelectorProps {
  models: Model[]
  selectedModel: Model | null
  onModelChange: (model: Model) => void
  disabled?: boolean
  isLoading?: boolean
  compact?: boolean
}

/** Get display text for a model: displayName or name */
function getModelDisplayText(model: Model): string {
  return model.displayName || model.name
}

/** Get unique key for model */
function getModelKey(model: Model): string {
  return `${model.namespace || 'default'}/${model.name}`
}

export function VideoModelSelector({
  models,
  selectedModel,
  onModelChange,
  disabled = false,
  isLoading = false,
  compact = false,
}: VideoModelSelectorProps) {
  const { t } = useTranslation('common')
  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')

  // Reset search when popover closes
  React.useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
    }
  }, [isOpen])

  const displayText = selectedModel ? getModelDisplayText(selectedModel) : t('video.model_selector')

  const isDisabled = disabled || isLoading

  // Tooltip content
  const tooltipContent =
    compact && selectedModel
      ? `${t('video.model_selector')}: ${displayText}`
      : t('video.model_selector')

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                role="combobox"
                aria-expanded={isOpen}
                aria-controls="video-model-selector-popover"
                disabled={isDisabled}
                className={cn(
                  'flex items-center gap-1 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
                  'border border-border bg-base text-text-primary hover:bg-hover',
                  'transition-colors focus:outline-none focus:ring-0',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  isLoading && 'animate-pulse'
                )}
              >
                <Video className="h-4 w-4 flex-shrink-0" />
                {!compact && <span className="truncate text-xs min-w-0">{displayText}</span>}
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
        <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
          <CommandInput
            placeholder={t('video.search_model')}
            value={searchValue}
            onValueChange={setSearchValue}
            className={cn(
              'h-9 rounded-none border-b border-border flex-shrink-0',
              'placeholder:text-text-muted text-sm'
            )}
          />
          <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
            {models.length === 0 ? (
              <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                {isLoading ? t('actions.loading') : t('video.no_models')}
              </CommandEmpty>
            ) : (
              <>
                <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                  {t('branches.no_match')}
                </CommandEmpty>
                <CommandGroup>
                  {models.map(model => (
                    <CommandItem
                      key={getModelKey(model)}
                      value={`${model.name} ${model.displayName || ''} ${model.provider}`}
                      onSelect={() => {
                        onModelChange(model)
                        setIsOpen(false)
                      }}
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
                          {model.type === 'user' && (
                            <Tag
                              variant="info"
                              className="text-[10px] flex-shrink-0 whitespace-nowrap"
                            >
                              {t('settings.personal')}
                            </Tag>
                          )}
                        </div>
                        <span className="text-xs text-text-muted truncate" title={model.provider}>
                          {model.provider}
                        </span>
                      </div>
                      <Check
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          selectedModel?.name === model.name &&
                            selectedModel?.namespace === model.namespace
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
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export default VideoModelSelector
