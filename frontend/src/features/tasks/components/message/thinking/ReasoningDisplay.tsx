// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

/** Delay (ms) before auto-collapsing after reasoning streaming ends */
const AUTO_COLLAPSE_DELAY = 800

interface ReasoningDisplayProps {
  /** Reasoning content from DeepSeek R1 and similar models */
  reasoningContent: string
  /** Whether reasoning content is actively streaming */
  isStreaming?: boolean
}

/**
 * Component to display reasoning/thinking content from models like DeepSeek R1.
 * Shows a collapsible panel with the model's chain-of-thought reasoning.
 * During streaming: expanded with real-time text and cursor animation.
 * After streaming ends: auto-collapses with a brief delay.
 */
const ReasoningDisplay = memo(function ReasoningDisplay({
  reasoningContent,
  isStreaming = false,
}: ReasoningDisplayProps) {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track if component was ever in streaming state
  const wasStreamingRef = useRef(isStreaming)
  const hasAutoCollapsedRef = useRef(false)

  // Start expanded when streaming, collapsed for historical messages
  const [isExpanded, setIsExpanded] = useState(isStreaming)

  // Update streaming ref when streaming starts
  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true
      // If streaming starts (or restarts), expand and clear any pending collapse
      setIsExpanded(true)
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
    }
  }, [isStreaming])

  // Auto-scroll to bottom when streaming and expanded
  useEffect(() => {
    if (isStreaming && isExpanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [reasoningContent, isStreaming, isExpanded])

  // Auto-collapse with delay when streaming ends
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && !hasAutoCollapsedRef.current) {
      collapseTimerRef.current = setTimeout(() => {
        setIsExpanded(false)
        hasAutoCollapsedRef.current = true
        collapseTimerRef.current = null
      }, AUTO_COLLAPSE_DELAY)
    }

    return () => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
    }
  }, [isStreaming])

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  if (!reasoningContent) {
    return null
  }

  const charCount = reasoningContent.length

  return (
    <div className="mb-3">
      {/* Header button */}
      <button
        onClick={toggleExpanded}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all hover:bg-surface/50 bg-purple-500/5 border-purple-500/20 text-purple-600 dark:text-purple-400"
        data-testid="reasoning-toggle"
      >
        <Brain className={`h-3.5 w-3.5 flex-shrink-0 ${isStreaming ? 'animate-pulse' : ''}`} />
        <span className="text-xs font-medium">
          {isStreaming
            ? t('chat:reasoning.thinking') || 'Thinking...'
            : `${t('chat:reasoning.thought_process') || 'Thought process'} · ${charCount} ${t('chat:reasoning.chars') || 'chars'}`}
        </span>
        {isExpanded ? (
          <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
        )}
      </button>

      {/* Collapsible content */}
      {isExpanded && (
        <div
          ref={contentRef}
          className="mt-2 ml-4 pl-4 border-l-2 border-purple-500/20 max-h-[7.5em] overflow-y-auto"
        >
          <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words font-mono leading-relaxed">
            {reasoningContent}
          </div>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-purple-500/60 animate-pulse ml-0.5" />
          )}
        </div>
      )}
    </div>
  )
})

export default ReasoningDisplay
