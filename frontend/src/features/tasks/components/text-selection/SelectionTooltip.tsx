// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquareQuote } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useTextSelection } from './useTextSelection'
import { useQuote } from './QuoteContext'

/**
 * Floating tooltip component that appears when user selects text in messages.
 * Provides a button to quote the selected text into the chat input.
 */
export function SelectionTooltip() {
  const { t } = useTranslation('chat')
  const { selection, clearSelection, isLocked } = useTextSelection()
  const { setQuote } = useQuote()

  const tooltipRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 })
  const hasSetPositionRef = useRef(false)

  // Update tooltip position when selection changes
  // Once locked, position stays fixed until selection is cleared
  useEffect(() => {
    if (selection && selection.isValid) {
      // Only update position if not locked or if this is the first time showing
      if (!isLocked || !hasSetPositionRef.current) {
        // Calculate position accounting for tooltip dimensions
        const tooltipWidth = 120 // Approximate width
        const tooltipHeight = 36 // Approximate height
        const padding = 8

        let left = selection.position.left - tooltipWidth / 2
        let top = selection.position.top - tooltipHeight - padding

        // Keep tooltip within viewport bounds
        left = Math.max(padding, Math.min(left, window.innerWidth - tooltipWidth - padding))
        top = Math.max(padding, top)

        setTooltipPosition({ top, left })
        hasSetPositionRef.current = true
      }
      setIsVisible(true)
    } else {
      setIsVisible(false)
      hasSetPositionRef.current = false
    }
  }, [selection, isLocked])

  // Handle click on the quote button
  const handleQuoteClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (selection && selection.text) {
        setQuote({ text: selection.text })
        clearSelection()

        // Focus the chat input after quoting
        setTimeout(() => {
          const chatInput = document.querySelector('[data-testid="message-input"]') as HTMLElement
          if (chatInput) {
            chatInput.focus()
          }
        }, 0)
      }
    },
    [selection, setQuote, clearSelection]
  )

  // Don't render if not visible or no valid selection
  if (!isVisible || !selection) {
    return null
  }

  return createPortal(
    <div
      ref={tooltipRef}
      data-selection-tooltip
      className="fixed z-[9999] animate-in fade-in-0 zoom-in-95 duration-150"
      style={{
        top: tooltipPosition.top,
        left: tooltipPosition.left,
      }}
    >
      <button
        onClick={handleQuoteClick}
        className="flex items-center gap-1.5 px-3 py-1.5
          bg-surface border border-border rounded-lg
          text-xs text-text-primary font-medium
          shadow-[0_2px_8px_rgba(0,0,0,0.08)]
          hover:bg-fill-tert hover:border-primary/30
          active:scale-95 transition-all duration-150
          cursor-pointer select-none"
      >
        <MessageSquareQuote className="h-3.5 w-3.5 text-primary" />
        <span>{t('quote.ask_wegent')}</span>
      </button>
    </div>,
    document.body
  )
}

export default SelectionTooltip
