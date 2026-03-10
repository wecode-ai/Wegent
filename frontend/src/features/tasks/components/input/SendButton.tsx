// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useCallback } from 'react'
import { ArrowUp } from 'lucide-react'
import LoadingDots from '../message/LoadingDots'

interface SendButtonProps {
  onClick: () => void
  disabled?: boolean
  isLoading?: boolean
  className?: string
  /** @deprecated No longer used, kept for API compatibility */
  compact?: boolean
}

export default function SendButton({
  onClick,
  disabled = false,
  isLoading = false,
  className = '',
}: SendButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Handle main button click (send message)
  const handleMainClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled && !isLoading) {
        onClick()
      }
    },
    [disabled, isLoading, onClick]
  )

  return (
    <div className={`relative inline-flex ${className}`}>
      {/* Send button - circular with larger icon */}
      <button
        ref={buttonRef}
        type="button"
        onClick={handleMainClick}
        disabled={disabled || isLoading}
        data-tour="send-button"
        data-testid="send-button"
        className={`
          flex items-center justify-center
          w-[34px] h-[34px]
          rounded-[24px]
          transition-colors duration-150
          ${disabled || isLoading ? 'bg-primary/50 cursor-not-allowed text-white/60' : 'bg-primary hover:bg-primary/90 text-white'}
        `}
      >
        {isLoading ? <LoadingDots /> : <ArrowUp className="h-4 w-4" />}
      </button>
    </div>
  )
}
