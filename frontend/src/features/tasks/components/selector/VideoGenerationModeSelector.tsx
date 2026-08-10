// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, ChevronDown, Video } from 'lucide-react'
import { useState } from 'react'

import type { VideoGenerationMode } from '@/apis/models'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface VideoGenerationModeSelectorProps {
  modes?: VideoGenerationMode[]
  value?: string
  onChange: (modeId: string) => void
  disabled?: boolean
}

export default function VideoGenerationModeSelector({
  modes = [],
  value,
  onChange,
  disabled = false,
}: VideoGenerationModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const selectedMode = modes.find(mode => mode.id === value) ?? modes[0]

  if (!selectedMode || modes.length <= 1) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 min-w-0 items-center gap-1.5 rounded-full border border-border',
            'bg-base px-3 text-xs text-text-primary transition-colors hover:bg-hover',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
          data-testid="video-generation-mode-selector"
        >
          <Video className="h-4 w-4 shrink-0" />
          <span className="max-w-28 truncate">{selectedMode.label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
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
