// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * GenerateModeSelector Component
 *
 * A component for selecting generation mode (video or image).
 * Uses Popover for dropdown selection with i18n support.
 * Only shown in generate page context.
 */

'use client'

import React, { useState } from 'react'
import { Video, ImageIcon, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TaskType } from '@/types/api'

/** Generation mode type - video or image */
export type GenerateMode = 'video' | 'image'

export interface GenerateModeSelectorProps {
  selectedMode: GenerateMode
  onModeChange: (mode: GenerateMode) => void
  disabled?: boolean
  compact?: boolean
}

// Mode configuration with icons and i18n keys
const MODE_CONFIG: Record<GenerateMode, { icon: typeof Video; labelKey: string }> = {
  video: { icon: Video, labelKey: 'video.title' },
  image: { icon: ImageIcon, labelKey: 'image.title' },
}

const AVAILABLE_MODES: GenerateMode[] = ['video', 'image']

export function GenerateModeSelector({
  selectedMode,
  onModeChange,
  disabled = false,
  compact = false,
}: GenerateModeSelectorProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)

  const currentConfig = MODE_CONFIG[selectedMode]
  const CurrentIcon = currentConfig.icon
  const displayText = t(currentConfig.labelKey)

  // Tooltip content
  const tooltipContent = compact
    ? `${t('generate.mode_selector')}: ${displayText}`
    : t('generate.mode_selector')

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
                  'flex items-center gap-1.5 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
                  'border border-border bg-base text-text-primary hover:bg-hover',
                  'transition-colors focus:outline-none focus:ring-0',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                <CurrentIcon className="h-4 w-4 flex-shrink-0" />
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
          'p-1 w-auto min-w-[140px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden'
        )}
        align="start"
        sideOffset={4}
      >
        <div className="flex flex-col">
          {AVAILABLE_MODES.map(mode => {
            const config = MODE_CONFIG[mode]
            const Icon = config.icon
            const label = t(config.labelKey)
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  onModeChange(mode)
                  setIsOpen(false)
                }}
                className={cn(
                  'flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-md',
                  'hover:bg-hover transition-colors',
                  selectedMode === mode && 'bg-primary/10'
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-text-secondary" />
                  <span className="text-text-primary">{label}</span>
                </div>
                {selectedMode === mode && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Helper function to check if a TaskType is a generation mode
 */
export function isGenerateMode(taskType: TaskType | undefined): taskType is GenerateMode {
  return taskType === 'video' || taskType === 'image'
}

export default GenerateModeSelector
