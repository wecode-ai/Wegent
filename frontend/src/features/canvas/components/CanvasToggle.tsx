// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { PanelRight, Layers } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface CanvasToggleProps {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
  /** Whether this toggle is locked (cannot be turned off) */
  locked?: boolean
}

/**
 * CanvasToggle - Canvas feature toggle button
 * Used to enable/disable canvas feature for new chats
 */
export function CanvasToggle({ enabled, onToggle, disabled = false, locked = false }: CanvasToggleProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              variant="outline"
              onClick={onToggle}
              disabled={disabled || (locked && enabled)}
              icon={<Layers className="h-4 w-4" />}
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
          <p>
            {locked && enabled
              ? 'Canvas 已启用（聊天中无法关闭）'
              : enabled
                ? '关闭 Canvas 功能'
                : '开启 Canvas 功能'}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface CanvasPanelToggleProps {
  isOpen: boolean
  onToggle: () => void
  disabled?: boolean
}

/**
 * CanvasPanelToggle - Canvas panel visibility toggle button
 * Used to show/hide the canvas panel when canvas feature is enabled
 */
export function CanvasPanelToggle({ isOpen, onToggle, disabled = false }: CanvasPanelToggleProps) {
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
                isOpen
                  ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-base text-text-primary hover:bg-hover'
              )}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{isOpen ? '隐藏工作台' : '显示工作台'}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
