// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, ChevronDown, ChevronRight, Video } from 'lucide-react'
import { useState } from 'react'

import type { VideoGenerationMode } from '@/apis/models'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface VideoGenerationModeSelectorProps {
  modes?: VideoGenerationMode[]
  value?: string
  onChange: (modeId: string) => void
  disabled?: boolean
  triggerVariant?: 'default' | 'menu-item'
  popoverSide?: 'top' | 'right' | 'bottom' | 'left'
  inline?: boolean
}

export default function VideoGenerationModeSelector({
  modes = [],
  value,
  onChange,
  disabled = false,
  triggerVariant = 'default',
  popoverSide,
  inline = false,
}: VideoGenerationModeSelectorProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const selectedMode = modes.find(mode => mode.id === value) ?? modes[0]

  if (!selectedMode || modes.length <= 1) {
    return null
  }

  if (inline) {
    return (
      <div className="p-4" data-testid="video-generation-mode-options">
        <h4 className="mb-2 text-sm font-medium text-text-primary">
          {t('video.generation_mode_section')}
        </h4>
        <div className="grid grid-cols-2 gap-2">
          {modes.map(mode => {
            const isSelected = mode.id === selectedMode.id
            return (
              <button
                key={mode.id}
                type="button"
                disabled={disabled}
                aria-pressed={isSelected}
                className={cn(
                  'min-h-11 rounded-lg border px-3 py-2 text-sm transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border bg-surface text-text-secondary hover:bg-hover',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
                onClick={() => onChange(mode.id)}
                data-testid={`video-generation-mode-${mode.id}`}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            triggerVariant === 'menu-item'
              ? 'h-11 w-full rounded-md px-3'
              : 'h-9 rounded-full border border-border px-3',
            'bg-base text-xs text-text-primary transition-colors hover:bg-hover',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
          data-testid="video-generation-mode-selector"
        >
          <Video className="h-4 w-4 shrink-0" />
          <span
            className={cn(
              'truncate',
              triggerVariant === 'menu-item' ? 'flex-1 text-left text-sm' : 'max-w-28'
            )}
          >
            {selectedMode.label}
          </span>
          {triggerVariant === 'menu-item' ? (
            <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={popoverSide ?? (triggerVariant === 'menu-item' ? 'right' : undefined)}
        sideOffset={4}
        className="w-auto min-w-40 rounded-xl border border-border bg-base p-1 shadow-xl"
      >
        {modes.map(mode => (
          <button
            key={mode.id}
            type="button"
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm',
              'text-text-primary transition-colors hover:bg-hover',
              mode.id === selectedMode.id && 'bg-primary/10'
            )}
            onClick={() => {
              onChange(mode.id)
              setOpen(false)
            }}
            data-testid={`video-generation-mode-${mode.id}`}
          >
            <span>{mode.label}</span>
            {mode.id === selectedMode.id && <Check className="h-4 w-4 text-primary" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
