// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, type ReactNode } from 'react'
import { EventSubscriptionPicker, type AutomationUiHost } from '@wegent/collaboration'

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

function WebPopupMenu({
  testId,
  trigger,
  children,
  disabled = false,
  invalid = false,
  menuWidth,
  fullWidth = false,
  triggerClassName,
  ariaLabel,
  onOpen,
}: {
  testId: string
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  disabled?: boolean
  invalid?: boolean
  menuWidth?: number
  fullWidth?: boolean
  triggerClassName?: string
  ariaLabel?: string
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <DropdownMenu
      open={open}
      onOpenChange={next => {
        if (next) onOpen?.()
        setOpen(next)
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-testid={testId}
          data-invalid={invalid || undefined}
          aria-label={ariaLabel}
          className={cn(
            'rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50',
            fullWidth && 'w-full',
            triggerClassName
          )}
        >
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid={`${testId}-menu`}
        align="end"
        style={{ minWidth: menuWidth ?? 180 }}
        onClick={event => event.stopPropagation()}
      >
        {children(close)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function WebTooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export const webAutomationUiHost: AutomationUiHost = {
  useTranslation,
  PopupMenu: WebPopupMenu,
  Tooltip: WebTooltip,
  EventSubscriptionPicker,
}
