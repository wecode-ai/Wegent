// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface CanvasToggleButtonProps {
  enabled: boolean
  onToggle: () => void
  className?: string
  disabled?: boolean
}

export function CanvasToggleButton({
  enabled,
  onToggle,
  className,
  disabled = false,
}: CanvasToggleButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={enabled ? 'secondary' : 'ghost'}
            size="icon"
            onClick={onToggle}
            disabled={disabled}
            className={cn(
              'h-8 w-8 transition-colors',
              enabled && 'bg-primary/10 text-primary hover:bg-primary/20',
              className
            )}
            aria-label={enabled ? 'Close Canvas' : 'Open Canvas'}
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{enabled ? 'Close Canvas' : 'Open Canvas'}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
