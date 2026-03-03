// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ResolutionSelector Component
 *
 * A component for selecting video resolution.
 * Uses Popover for dropdown selection with i18n support.
 */

'use client'

import React, { useState } from 'react'
import { Monitor, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export interface ResolutionSelectorProps {
  selectedResolution: string
  onResolutionChange: (resolution: string) => void
  availableResolutions?: string[]
  disabled?: boolean
  compact?: boolean
}

// Resolution labels with i18n keys
const RESOLUTION_LABELS: Record<string, { zhKey: string; enKey: string }> = {
  '480p': { zhKey: 'video.resolution.480p', enKey: 'video.resolution.480p' },
  '720p': { zhKey: 'video.resolution.720p', enKey: 'video.resolution.720p' },
  '1080p': { zhKey: 'video.resolution.1080p', enKey: 'video.resolution.1080p' },
  '4k': { zhKey: 'video.resolution.4k', enKey: 'video.resolution.4k' },
}

export function ResolutionSelector({
  selectedResolution,
  onResolutionChange,
  availableResolutions = ['480p', '720p', '1080p'],
  disabled = false,
  compact = false,
}: ResolutionSelectorProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)

  // Get display text for resolution
  const getResolutionLabel = (resolution: string): string => {
    const labelConfig = RESOLUTION_LABELS[resolution]
    if (labelConfig) {
      return t(labelConfig.zhKey)
    }
    return resolution
  }

  const displayText = getResolutionLabel(selectedResolution)

  // Tooltip content
  const tooltipContent = compact
    ? `${t('video.resolution_selector')}: ${displayText}`
    : t('video.resolution_selector')

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  'flex items-center gap-1 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
                  'border border-border bg-base text-text-primary hover:bg-hover',
                  'transition-colors focus:outline-none focus:ring-0',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                <Monitor className="h-4 w-4 flex-shrink-0" />
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
          'p-1 w-auto min-w-[160px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden'
        )}
        align="start"
        sideOffset={4}
      >
        <div className="flex flex-col">
          {availableResolutions.map(resolution => (
            <button
              key={resolution}
              type="button"
              onClick={() => {
                onResolutionChange(resolution)
                setIsOpen(false)
              }}
              className={cn(
                'flex items-center justify-between px-3 py-2 text-sm rounded-md',
                'hover:bg-hover transition-colors',
                selectedResolution === resolution && 'bg-primary/10'
              )}
            >
              <span className="text-text-primary">{getResolutionLabel(resolution)}</span>
              {selectedResolution === resolution && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ResolutionSelector
