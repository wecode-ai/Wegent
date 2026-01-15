// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
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
    <button
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'relative w-8 h-8 rounded-[7px] bg-base border border-border hover:bg-hover focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary transition-all duration-200',
        enabled && 'bg-primary/10 border-primary/20',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      title={enabled ? '关闭 Canvas' : '打开 Canvas'}
    >
      <svg
        className="w-3.5 h-3.5 text-text-primary absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 transition-transform duration-200"
        style={{
          transform: enabled ? 'translate(-50%, -50%) rotate(180deg)' : 'translate(-50%, -50%)',
        }}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5l7 7-7 7"
        />
      </svg>
    </button>
  )
}
