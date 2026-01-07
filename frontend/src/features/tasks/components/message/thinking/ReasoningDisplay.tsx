// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState, useRef, useEffect } from 'react'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface ReasoningDisplayProps {
  /** Reasoning content from DeepSeek R1 and similar models */
  reasoningContent: string
  /** Whether the message is still streaming */
  isStreaming?: boolean
}

/**
 * Component to display reasoning/thinking content from models like DeepSeek R1.
 * Shows a collapsible panel with the model's chain-of-thought reasoning.
 * Auto-collapses when streaming ends.
 */
const ReasoningDisplay = memo(function ReasoningDisplay({
  reasoningContent,
  isStreaming = false,
}: ReasoningDisplayProps) {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)

  // Track if component mounted during active streaming
  // This helps distinguish between live streaming and historical messages
  const mountedDuringStreamingRef = useRef(isStreaming)
  const hasAutoCollapsedRef = useRef(false)

  // Initialize expanded state based on whether we're streaming
  // - Streaming messages: start expanded to show live reasoning
  // - Historical messages (not streaming): start collapsed
  const [isExpanded, setIsExpanded] = useState(isStreaming)

  // Auto-scroll to bottom when streaming and expanded
  useEffect(() => {
    if (isStreaming && isExpanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [reasoningContent, isStreaming, isExpanded])

  // Auto-collapse when streaming ends
  // Only applies to messages that were streaming when this component mounted
  useEffect(() => {
    if (mountedDuringStreamingRef.current && !isStreaming && !hasAutoCollapsedRef.current) {
      setIsExpanded(false)
      hasAutoCollapsedRef.current = true
    }
  }, [isStreaming])

  if (!reasoningContent) {
    return null
  }

  // Calculate approximate token/character count for display
  const charCount = reasoningContent.length

  return (
    <div className="mb-3">
      {/* Header button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all hover:bg-surface/50 bg-purple-500/5 border-purple-500/20 text-purple-600 dark:text-purple-400"
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
          className="mt-2 ml-4 pl-4 border-l-2 border-purple-500/20 max-h-[400px] overflow-y-auto"
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
