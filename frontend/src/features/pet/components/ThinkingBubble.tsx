// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * ThinkingBubble component
 *
 * Shows a speech bubble with animated typing dots when AI is generating output.
 * Appears above the pet widget to indicate the pet is "thinking" or "working".
 * The dots start animating after a 1.6s delay.
 */

import React, { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface ThinkingBubbleProps {
  className?: string
}

export function ThinkingBubble({ className }: ThinkingBubbleProps) {
  const [showDots, setShowDots] = useState(false)

  // Delay showing the dots by 1.6 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowDots(true)
    }, 1600)

    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={cn(
        'absolute -top-8 -left-2',
        'bg-surface border border-border rounded-xl px-3 py-2',
        'shadow-md animate-fade-in',
        className
      )}
    >
      {/* Speech bubble tail - positioned at bottom right to point to pet */}
      <div className="absolute -bottom-2 right-3 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-border" />
      <div className="absolute -bottom-[6px] right-[13px] w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[7px] border-t-surface" />

      {/* Typing dots - shown after 1.6s delay */}
      <div className="flex items-center gap-1">
        {showDots ? (
          <>
            <span
              className="w-2 h-2 rounded-full bg-primary animate-thinking-dot"
              style={{ animationDelay: '0s' }}
            />
            <span
              className="w-2 h-2 rounded-full bg-primary animate-thinking-dot"
              style={{ animationDelay: '0.2s' }}
            />
            <span
              className="w-2 h-2 rounded-full bg-primary animate-thinking-dot"
              style={{ animationDelay: '0.4s' }}
            />
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-primary opacity-40" />
            <span className="w-2 h-2 rounded-full bg-primary opacity-40" />
            <span className="w-2 h-2 rounded-full bg-primary opacity-40" />
          </>
        )}
      </div>
    </div>
  )
}
