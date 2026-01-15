// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
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
        'flex items-center gap-2 px-4 py-3 border-t border-border bg-muted/30 overflow-x-auto',
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
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const Icon = action.icon

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  // If action has options, show popover
  if (action.options && action.options.length > 0) {
    return (
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={() => setOpen(!open)}
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            'bg-surface border border-border text-text-primary',
            'hover:bg-muted focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary',
            disabled && 'opacity-50 cursor-not-allowed',
            open && 'bg-muted'
          )}
        >
          <Icon className="h-4 w-4" />
          {action.labelZh}
          <ChevronDownIcon className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <div
            ref={popoverRef}
            className="absolute bottom-full left-0 mb-2 w-40 rounded-lg border border-border bg-surface shadow-lg z-50"
          >
            <div className="py-1">
              {action.options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    onAction(action.id, option.value)
                    setOpen(false)
                  }}
                  className="w-full px-3 py-2 text-sm text-left text-text-primary hover:bg-muted transition-colors"
                >
                  {option.labelZh}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // Simple action without options
  return (
    <button
      disabled={disabled}
      onClick={() => onAction(action.id)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        'bg-surface border border-border text-text-primary',
        'hover:bg-muted focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <Icon className="h-4 w-4" />
      {action.labelZh}
    </button>
  )
}
