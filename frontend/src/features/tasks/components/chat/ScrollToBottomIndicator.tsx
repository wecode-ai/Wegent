// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { ChevronDown } from 'lucide-react'

interface ScrollToBottomIndicatorProps {
  /**
   * Whether the indicator should be visible.
   * When true, shows the indicator with animation.
   */
  visible: boolean

  /**
   * Callback function when the indicator is clicked.
   * Should scroll to the bottom of the message list.
   */
  onClick: () => void
}

/**
 * ScrollToBottomIndicator Component
 *
 * A small circular button that appears when the user scrolls up in the chat.
 * Clicking it scrolls the message list to the bottom (most recent messages).
 *
 * Design inspired by Doubao chat interface:
 * - Circular button with downward chevron icon
 * - Appears above the input area with smooth fade animation
 * - Provides visual feedback on hover
 */
export function ScrollToBottomIndicator({ visible, onClick }: ScrollToBottomIndicatorProps) {
  if (!visible) return null

  return (
    <button
      type="button"
      onClick={onClick}
      className="
        flex items-center justify-center
        w-8 h-8 rounded-full
        bg-surface border border-border
        shadow-sm
        text-text-secondary hover:text-text-primary
        hover:bg-base hover:border-border-hover
        transition-all duration-200
        cursor-pointer
        animate-in fade-in slide-in-from-bottom-2 duration-200
      "
      aria-label="Scroll to bottom"
    >
      <ChevronDown className="w-4 h-4" />
    </button>
  )
}

export default ScrollToBottomIndicator
