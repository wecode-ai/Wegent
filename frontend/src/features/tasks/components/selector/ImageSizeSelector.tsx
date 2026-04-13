// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ImageSizeSelector Component
 *
 * A component for selecting image generation size/resolution.
 * Uses Popover for dropdown selection with i18n support.
 */

'use client'

import React, { useState } from 'react'
import { ImageIcon, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export interface ImageSizeOption {
  value: string
  label: string
}

export interface ImageSizeSelectorProps {
  selectedSize: string
  onSizeChange: (size: string) => void
  availableSizes?: ImageSizeOption[]
  disabled?: boolean
  compact?: boolean
}

// Default available sizes for image generation
const DEFAULT_IMAGE_SIZES: ImageSizeOption[] = [
  { value: '1024x1024', label: '1K (1024×1024)' },
  { value: '2048x2048', label: '2K (2048×2048)' },
  { value: '2K', label: '2K (自适应)' },
  { value: '3K', label: '3K (自适应)' },
  { value: '2304x1728', label: '2K 4:3 横屏' },
  { value: '1728x2304', label: '2K 3:4 竖屏' },
  { value: '2848x1600', label: '2K 16:9 横屏' },
  { value: '1600x2848', label: '2K 9:16 竖屏' },
]

export function ImageSizeSelector({
  selectedSize,
  onSizeChange,
  availableSizes = DEFAULT_IMAGE_SIZES,
  disabled = false,
  compact = false,
}: ImageSizeSelectorProps) {
  const { t } = useTranslation('common')
  const [isOpen, setIsOpen] = useState(false)

  // Get display text for selected size
  const getDisplayText = (): string => {
    const sizeOption = availableSizes.find(s => s.value === selectedSize)
    return sizeOption?.label || selectedSize
  }

  const displayText = getDisplayText()

  // Tooltip content
  const tooltipContent = compact
    ? `${t('image.size_selector')}: ${displayText}`
    : t('image.size_selector')

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
                <ImageIcon className="h-4 w-4 flex-shrink-0" />
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
          'p-1 w-auto min-w-[200px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden'
        )}
        align="start"
        sideOffset={4}
      >
        <div className="flex flex-col max-h-[300px] overflow-y-auto">
          {availableSizes.map(size => (
            <button
              key={size.value}
              type="button"
              onClick={() => {
                onSizeChange(size.value)
                setIsOpen(false)
              }}
              className={cn(
                'flex items-center justify-between px-3 py-2 text-sm rounded-md',
                'hover:bg-hover transition-colors',
                selectedSize === size.value && 'bg-primary/10'
              )}
            >
              <span className="text-text-primary">{size.label}</span>
              {selectedSize === size.value && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ImageSizeSelector
