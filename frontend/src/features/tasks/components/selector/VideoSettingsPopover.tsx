// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * VideoSettingsPopover Component
 *
 * A unified popover that combines aspect ratio, duration, and resolution
 * selection for video generation. The trigger button shows a summary like:
 * "⚙ 16:9 · 5S · 720P"
 */

'use client'

import React, { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { AspectRatioOption, ResolutionOption } from '@/apis/models'

export interface VideoSettingsPopoverProps {
  // Aspect ratio
  selectedRatio: string
  onRatioChange: (ratio: string) => void
  availableRatios: string[]
  ratioOptions?: AspectRatioOption[]
  // Duration
  selectedDuration: number
  onDurationChange: (duration: number) => void
  availableDurations: number[]
  // Resolution
  selectedResolution: string
  onResolutionChange: (resolution: string) => void
  availableResolutions: string[]
  resolutionOptions?: ResolutionOption[]
  // State
  disabled?: boolean
}

// Aspect ratio icon dimensions for visual representation
const RATIO_ICON_STYLES: Record<string, { width: string; height: string }> = {
  '16:9': { width: '24px', height: '14px' },
  '4:3': { width: '20px', height: '16px' },
  '1:1': { width: '16px', height: '16px' },
  '3:4': { width: '14px', height: '18px' },
  '9:16': { width: '12px', height: '20px' },
  '21:9': { width: '28px', height: '12px' },
}

function RatioIcon({ ratio, selected }: { ratio: string; selected: boolean }) {
  const style = RATIO_ICON_STYLES[ratio] || { width: '16px', height: '16px' }
  return (
    <div
      className={cn(
        'rounded-[2px] border-[1.5px] transition-colors',
        selected ? 'border-primary' : 'border-text-muted/50'
      )}
      style={{ width: style.width, height: style.height }}
    />
  )
}

export function VideoSettingsPopover({
  selectedRatio,
  onRatioChange,
  availableRatios,
  ratioOptions,
  selectedDuration,
  onDurationChange,
  availableDurations,
  selectedResolution,
  onResolutionChange,
  availableResolutions,
  resolutionOptions,
  disabled = false,
}: VideoSettingsPopoverProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)

  // Build summary text for trigger button
  const selectedRatioLabel =
    ratioOptions?.find(option => option.value === selectedRatio)?.label ?? selectedRatio
  const selectedResolutionLabel =
    resolutionOptions?.find(option => (option.value ?? option.label) === selectedResolution)
      ?.label ?? selectedResolution.toUpperCase()
  const summaryText = `${selectedRatioLabel} · ${selectedDuration}S · ${selectedResolutionLabel}`
  const displayedRatios = ratioOptions?.length
    ? ratioOptions
    : availableRatios.map(value => ({ label: value, value }))
  const displayedResolutions = resolutionOptions?.length
    ? resolutionOptions
    : availableResolutions.map(value => ({ label: value.toUpperCase(), value }))

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex items-center gap-1.5 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
            'border border-border bg-base text-text-primary hover:bg-hover',
            'transition-colors focus:outline-none focus:ring-0',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <SlidersHorizontal className="h-4 w-4 flex-shrink-0" />
          <span className="truncate text-xs min-w-0">{summaryText}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        className={cn(
          'p-4 w-auto min-w-[320px] max-w-[400px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden'
        )}
        align="start"
        sideOffset={4}
      >
        <div className="space-y-4">
          {/* Aspect Ratio Section */}
          <div>
            <h4 className="text-sm font-medium text-text-primary mb-2">
              {t('video.ratio_section')}
            </h4>
            <div className="flex flex-wrap gap-2">
              {displayedRatios.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onRatioChange(option.value)}
                  className={cn(
                    'flex flex-col items-center gap-1 px-3 py-2 rounded-lg',
                    'border transition-colors min-w-[52px]',
                    selectedRatio === option.value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border bg-surface hover:bg-hover text-text-secondary'
                  )}
                >
                  <RatioIcon ratio={option.value} selected={selectedRatio === option.value} />
                  <span className="text-xs">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Duration Section */}
          <div>
            <h4 className="text-sm font-medium text-text-primary mb-2">
              {t('video.duration_section')}
            </h4>
            <div className="flex gap-2">
              {availableDurations.map(duration => (
                <button
                  key={duration}
                  type="button"
                  onClick={() => onDurationChange(duration)}
                  className={cn(
                    'flex-1 py-2 rounded-lg border transition-colors text-sm',
                    selectedDuration === duration
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border bg-surface hover:bg-hover text-text-secondary'
                  )}
                >
                  {duration}S
                </button>
              ))}
            </div>
          </div>

          {/* Resolution Section */}
          <div>
            <h4 className="text-sm font-medium text-text-primary mb-2">
              {t('video.resolution_section')}
            </h4>
            <div className="flex gap-2">
              {displayedResolutions.map(option => {
                const value = option.value ?? option.label
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onResolutionChange(value)}
                    title={'tooltip' in option ? option.tooltip : undefined}
                    className={cn(
                      'flex-1 py-2 rounded-lg border transition-colors text-sm',
                      selectedResolution === value
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-border bg-surface hover:bg-hover text-text-secondary'
                    )}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default VideoSettingsPopover
