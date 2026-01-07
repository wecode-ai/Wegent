// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { memo, useState, useMemo } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Default configuration for collapsible messages
 */
const DEFAULT_COLLAPSE_LINES = 10

export interface CollapsibleMessageProps {
  /** The content to render */
  children: React.ReactNode
  /** Raw text content to calculate line count */
  content: string
  /** Maximum lines before collapsing (default: 10) */
  maxLines?: number
  /** Whether collapsing is enabled (default: true) */
  enabled?: boolean
  /** Custom class name for the container */
  className?: string
}

/**
 * Check if content should be collapsed based on line count
 */
function shouldCollapseContent(content: string, maxLines: number): boolean {
  if (!content || typeof content !== 'string') {
    return false
  }

  const lines = content.split('\n')
  return lines.length > maxLines
}

/**
 * CollapsibleMessage component
 *
 * Wraps message content and collapses it if it exceeds the maximum line count.
 * Shows an "Expand" button to reveal full content.
 */
const CollapsibleMessage = memo(function CollapsibleMessage({
  children,
  content,
  maxLines = DEFAULT_COLLAPSE_LINES,
  enabled = true,
  className = '',
}: CollapsibleMessageProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(false)

  const isCollapsible = useMemo(() => {
    if (!enabled) return false
    return shouldCollapseContent(content, maxLines)
  }, [content, maxLines, enabled])

  // If not collapsible, render children directly
  if (!isCollapsible) {
    return <div className={className}>{children}</div>
  }

  return (
    <div className={className}>
      {/* Content container with collapse effect */}
      <div
        className={`relative ${!isExpanded ? 'max-h-[400px] overflow-hidden' : ''}`}
        style={!isExpanded ? { maxHeight: `${maxLines * 1.75}em` } : undefined}
      >
        {children}

        {/* Gradient fade effect when collapsed */}
        {!isExpanded && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-base to-transparent pointer-events-none" />
        )}
      </div>

      {/* Expand/Collapse button */}
      <div className="flex justify-center mt-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-primary hover:text-primary/80 hover:bg-primary/5 rounded-lg transition-colors"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="h-4 w-4" />
              <span>{t('messages.collapse_content') || 'Collapse'}</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-4 w-4" />
              <span>{t('messages.expand_content') || 'Expand'}</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
})

export default CollapsibleMessage
