// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { MessageSquareMore } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

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
  const handleClick = () => {
    if (!disabled) {
      onToggle(!enabled)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2.5',
        'text-left transition-colors',
        'hover:bg-hover active:bg-hover',
        'disabled:opacity-50 disabled:cursor-not-allowed'
      )}
    >
      <div className="flex items-center gap-3">
        <MessageSquareMore className="h-4 w-4 text-text-muted" />
        <span className="text-sm">追问澄清</span>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={disabled}
        onClick={e => e.stopPropagation()}
      />
    </button>
  )
}
