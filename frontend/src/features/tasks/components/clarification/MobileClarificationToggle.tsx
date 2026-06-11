// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { MessageSquareMore } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

interface MobileClarificationToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  disabled?: boolean
}

/**
 * Mobile-specific Clarification Toggle
 * Renders as a full-width clickable row with a switch
 */
export default function MobileClarificationToggle({
  enabled,
  onToggle,
  disabled = false,
}: MobileClarificationToggleProps) {
  const { t } = useTranslation('chat')

  const handleClick = () => {
    if (!disabled) {
      onToggle(!enabled)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    handleClick()
  }

  return (
    <div
      role="button"
      data-testid="toggle-clarification"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2.5',
        'text-left transition-colors',
        'hover:bg-hover active:bg-hover',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <div className="flex items-center gap-3">
        <MessageSquareMore className="h-4 w-4 text-text-muted" />
        <span className="text-sm">{t('clarification_toggle.label')}</span>
      </div>
      <Switch
        data-testid="clarification-switch"
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={disabled}
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}
