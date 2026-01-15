// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getQuickActions, type QuickActionDef } from '../constants/quickActions'

interface QuickActionsBarProps {
  artifactType: 'code' | 'text'
  onAction: (actionId: string, optionValue?: string) => void
  disabled?: boolean
  className?: string
}

export function QuickActionsBar({
  artifactType,
  onAction,
  disabled = false,
  className,
}: QuickActionsBarProps) {
  const quickActions = getQuickActions(artifactType)

  return (
    <div
      className={cn(
        'flex items-center gap-1 px-4 py-2 border-t bg-muted/50 overflow-x-auto',
        className
      )}
    >
      {quickActions.map((action) => (
        <QuickActionButton
          key={action.id}
          action={action}
          onAction={onAction}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

interface QuickActionButtonProps {
  action: QuickActionDef
  onAction: (actionId: string, optionValue?: string) => void
  disabled?: boolean
}

function QuickActionButton({ action, onAction, disabled }: QuickActionButtonProps) {
  const [open, setOpen] = useState(false)
  const Icon = action.icon

  // If action has options, show popover
  if (action.options && action.options.length > 0) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-8 px-3 text-xs gap-1.5 shrink-0"
          >
            <Icon className="h-3.5 w-3.5" />
            {action.labelZh}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-40 p-1" align="start">
          {action.options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onAction(action.id, option.value)
                setOpen(false)
              }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-muted rounded transition-colors"
            >
              {option.labelZh}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    )
  }

  // Simple action without options
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => onAction(action.id)}
      className="h-8 px-3 text-xs gap-1.5 shrink-0"
    >
      <Icon className="h-3.5 w-3.5" />
      {action.labelZh}
    </Button>
  )
}
