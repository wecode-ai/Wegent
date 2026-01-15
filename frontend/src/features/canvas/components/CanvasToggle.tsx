// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { PanelRight } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface CanvasToggleProps {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
}

export function CanvasToggle({ enabled, onToggle, disabled = false }: CanvasToggleProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              variant="outline"
              onClick={onToggle}
              disabled={disabled}
              icon={<PanelRight className="h-4 w-4" />}
              className={cn(
                'transition-colors',
                enabled
                  ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-base text-text-primary hover:bg-hover'
              )}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{enabled ? '关闭 Canvas' : '打开 Canvas'}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
