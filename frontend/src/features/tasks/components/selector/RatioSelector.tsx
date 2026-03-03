// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * RatioSelector Component
 *
 * A component for selecting video aspect ratio.
 * Uses Popover for dropdown selection with i18n support.
 */

'use client'

import React, { useState } from 'react'
import { RectangleHorizontal, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export interface RatioSelectorProps {
  selectedRatio: string
  onRatioChange: (ratio: string) => void
  availableRatios?: string[]
  disabled?: boolean
  compact?: boolean
}

// Ratio labels with i18n keys
// Note: Using underscore instead of colon in keys because colon is namespace separator in i18next
const RATIO_LABELS: Record<string, string> = {
  '16:9': 'video.ratio.16_9',
  '9:16': 'video.ratio.9_16',
  '1:1': 'video.ratio.1_1',
  '4:3': 'video.ratio.4_3',
  '3:4': 'video.ratio.3_4',
  '21:9': 'video.ratio.21_9',
  adaptive: 'video.ratio.adaptive',
}

export function RatioSelector({
  selectedRatio,
  onRatioChange,
  availableRatios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
  disabled = false,
  compact = false,
}: RatioSelectorProps) {
  const { t } = useTranslation('common')
  const [isOpen, setIsOpen] = useState(false)

  // Get display text for ratio
  const getRatioLabel = (ratio: string): string => {
    const labelKey = RATIO_LABELS[ratio]
    if (labelKey) {
      return t(labelKey)
    }
    return ratio
  }

  const displayText = getRatioLabel(selectedRatio)

  // Tooltip content - use a generic tooltip since there's no specific key for ratio selector
  const tooltipContent = compact
    ? `${t('models.video_ratio')}: ${displayText}`
    : t('models.video_ratio')

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
                <RectangleHorizontal className="h-4 w-4 flex-shrink-0" />
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
          {availableRatios.map(ratio => (
            <button
              key={ratio}
              type="button"
              onClick={() => {
                onRatioChange(ratio)
                setIsOpen(false)
              }}
              className={cn(
                'flex items-center justify-between px-3 py-2 text-sm rounded-md',
                'hover:bg-hover transition-colors',
                selectedRatio === ratio && 'bg-primary/10'
              )}
            >
              <span className="text-text-primary">{getRatioLabel(ratio)}</span>
              {selectedRatio === ratio && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default RatioSelector
