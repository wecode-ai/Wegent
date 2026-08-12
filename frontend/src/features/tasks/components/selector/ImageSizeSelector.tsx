// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface ImageSizeOption {
  value: string
  label: string
  ratio?: string
  resolution?: string
}

export interface ImageSizeSelectorProps {
  selectedSize: string
  onSizeChange: (size: string) => void
  availableSizes?: ImageSizeOption[]
  disabled?: boolean
  compact?: boolean
}

const DEFAULT_IMAGE_SIZES: ImageSizeOption[] = [
  { value: '1024x1024', label: '1024x1024', ratio: '1:1', resolution: '1K' },
  { value: '1152x864', label: '1152x864', ratio: '4:3', resolution: '1K' },
  { value: '864x1152', label: '864x1152', ratio: '3:4', resolution: '1K' },
  { value: '1280x720', label: '1280x720', ratio: '16:9', resolution: '1K' },
  { value: '720x1280', label: '720x1280', ratio: '9:16', resolution: '1K' },
  { value: '1248x832', label: '1248x832', ratio: '3:2', resolution: '1K' },
  { value: '832x1248', label: '832x1248', ratio: '2:3', resolution: '1K' },
  { value: '1512x648', label: '1512x648', ratio: '21:9', resolution: '1K' },
  { value: '2048x2048', label: '2048x2048', ratio: '1:1', resolution: '2K' },
  { value: '2304x1728', label: '2304x1728', ratio: '4:3', resolution: '2K' },
  { value: '1728x2304', label: '1728x2304', ratio: '3:4', resolution: '2K' },
  { value: '2848x1600', label: '2848x1600', ratio: '16:9', resolution: '2K' },
  { value: '1600x2848', label: '1600x2848', ratio: '9:16', resolution: '2K' },
  { value: '2496x1664', label: '2496x1664', ratio: '3:2', resolution: '2K' },
  { value: '1664x2496', label: '1664x2496', ratio: '2:3', resolution: '2K' },
  { value: '3136x1344', label: '3136x1344', ratio: '21:9', resolution: '2K' },
]

const RATIO_ICON_STYLES: Record<string, { width: number; height: number }> = {
  '21:9': { width: 28, height: 12 },
  '16:9': { width: 24, height: 14 },
  '3:2': { width: 22, height: 15 },
  '4:3': { width: 20, height: 16 },
  '1:1': { width: 16, height: 16 },
  '3:4': { width: 14, height: 18 },
  '2:3': { width: 13, height: 19 },
  '9:16': { width: 12, height: 20 },
}

function RatioIcon({ ratio, selected }: { ratio: string; selected: boolean }) {
  const size = RATIO_ICON_STYLES[ratio] ?? RATIO_ICON_STYLES['1:1']

  return (
    <span className="flex h-6 items-center justify-center">
      <span
        className={cn(
          'rounded-[2px] border-[1.5px]',
          selected ? 'border-text-primary' : 'border-text-muted/40'
        )}
        style={size}
      />
    </span>
  )
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

export function ImageSizeSelector({
  selectedSize,
  onSizeChange,
  availableSizes = DEFAULT_IMAGE_SIZES,
  disabled = false,
  compact = false,
}: ImageSizeSelectorProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const selectedOption =
    availableSizes.find(option => option.value === selectedSize) ?? availableSizes[0]
  const ratios = useMemo(() => unique(availableSizes.map(option => option.ratio)), [availableSizes])
  const resolutions = useMemo(
    () => unique(availableSizes.map(option => option.resolution)),
    [availableSizes]
  )
  const selectedRatio = selectedOption?.ratio ?? ratios[0] ?? ''
  const selectedResolution = selectedOption?.resolution ?? resolutions[0] ?? ''

  const selectPreset = (ratio: string, resolution: string) => {
    const next =
      availableSizes.find(option => option.ratio === ratio && option.resolution === resolution) ??
      availableSizes.find(option => option.ratio === ratio) ??
      availableSizes.find(option => option.resolution === resolution)

    if (next) {
      onSizeChange(next.value)
    }
  }

  const summary = [selectedRatio, selectedResolution, selectedOption?.value ?? selectedSize]
    .filter(Boolean)
    .join(' · ')

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="image-size-selector-trigger"
          className={cn(
            'flex h-9 min-w-0 items-center gap-1 rounded-full px-2.5 text-text-primary',
            'bg-surface transition-colors hover:bg-base focus:outline-none focus:ring-0',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <SlidersHorizontal className="h-4 w-4 flex-shrink-0" />
          {!compact && <span className="truncate text-sm">{summary}</span>}
        </button>
      </PopoverTrigger>

      <PopoverContent
        data-testid="image-size-selector-content"
        className="w-[400px] max-w-[calc(100vw-24px)] rounded-lg border-border bg-base p-4 text-text-primary shadow-xl"
        align="start"
        sideOffset={4}
      >
        <div className="space-y-4">
          <section>
            <h4 className="mb-2 text-sm font-medium text-text-primary">
              {t('image.ratio_section')}
            </h4>
            <div className="flex flex-wrap gap-1 rounded bg-surface p-1">
              {ratios.map(ratio => (
                <button
                  key={ratio}
                  type="button"
                  data-testid={`image-ratio-${ratio.replace(':', '-')}`}
                  onClick={() => selectPreset(ratio, selectedResolution)}
                  className={cn(
                    'flex min-w-[52px] flex-col items-center justify-center gap-1 rounded px-2 py-1.5',
                    'text-xs transition-colors',
                    selectedRatio === ratio
                      ? 'bg-primary/10 text-text-primary'
                      : 'text-text-secondary hover:bg-base'
                  )}
                >
                  <RatioIcon ratio={ratio} selected={selectedRatio === ratio} />
                  <span>{ratio}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-text-primary">
              {t('image.resolution_section')}
            </h4>
            <div className="flex gap-1 rounded bg-surface p-1">
              {resolutions.map(resolution => (
                <button
                  key={resolution}
                  type="button"
                  data-testid={`image-resolution-${resolution.toLowerCase()}`}
                  onClick={() => selectPreset(selectedRatio, resolution)}
                  className={cn(
                    'flex-1 rounded py-1.5 text-sm transition-colors',
                    selectedResolution === resolution
                      ? 'bg-primary/10 text-text-primary'
                      : 'text-text-secondary hover:bg-base'
                  )}
                >
                  {resolution}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-text-primary">
              {t('image.size_section')}
            </h4>
            <div
              className="rounded bg-surface px-3 py-2 text-sm text-text-secondary"
              data-testid="image-size-value"
            >
              {selectedOption?.value ?? selectedSize}
            </div>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ImageSizeSelector
