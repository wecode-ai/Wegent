// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback } from 'react'
import { Check, X, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { useAIAssist } from './AIAssistContext'
import type { DiffResult, AIAssistSource } from './types'

/**
 * Compute diff segments between original and replacement text
 * Returns an array of segments with type: 'unchanged', 'deleted', 'added'
 */
interface DiffSegment {
  type: 'unchanged' | 'deleted' | 'added'
  text: string
}

function computeDiffSegments(original: string, replacement: string): DiffSegment[] {
  const segments: DiffSegment[] = []

  // Simple line-by-line diff for readability
  const originalLines = original.split('\n')
  const replacementLines = replacement.split('\n')

  let i = 0
  let j = 0

  while (i < originalLines.length || j < replacementLines.length) {
    if (i >= originalLines.length) {
      // Remaining replacement lines are additions
      segments.push({ type: 'added', text: replacementLines[j] })
      j++
    } else if (j >= replacementLines.length) {
      // Remaining original lines are deletions
      segments.push({ type: 'deleted', text: originalLines[i] })
      i++
    } else if (originalLines[i] === replacementLines[j]) {
      // Lines match - unchanged
      segments.push({ type: 'unchanged', text: originalLines[i] })
      i++
      j++
    } else {
      // Lines differ - check for similarity
      // For simplicity, mark original as deleted and replacement as added
      segments.push({ type: 'deleted', text: originalLines[i] })
      segments.push({ type: 'added', text: replacementLines[j] })
      i++
      j++
    }
  }

  return segments
}

interface InlineDiffProps {
  /** The diff result to display */
  diff: DiffResult
  /** Whether AI is currently generating (show streaming content) */
  isStreaming?: boolean
  /** Streaming content while generating */
  streamingContent?: string
  /** Additional class name */
  className?: string
}

/**
 * Inline diff component that shows AI changes with accept/reject actions
 */
export function InlineDiff({ diff, isStreaming, streamingContent, className }: InlineDiffProps) {
  const { t } = useTranslation('knowledge')
  const { acceptDiff, rejectDiff, regenerate, state } = useAIAssist()
  const { status } = state

  // Compute diff segments
  const displayContent = isStreaming ? (streamingContent || '') : diff.replacement
  const segments = computeDiffSegments(diff.original, displayContent)

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isStreaming || status !== 'completed') return

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        acceptDiff()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        rejectDiff()
      }
    },
    [isStreaming, status, acceptDiff, rejectDiff]
  )

  return (
    <div
      className={cn(
        'inline-diff rounded-lg border border-border bg-surface overflow-hidden',
        className
      )}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Diff content */}
      <div className="p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        {segments.map((segment, index) => (
          <React.Fragment key={index}>
            {segment.type === 'unchanged' && (
              <span className="text-text-primary">{segment.text}</span>
            )}
            {segment.type === 'deleted' && (
              <span className="bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 line-through">
                {segment.text}
              </span>
            )}
            {segment.type === 'added' && (
              <span className="bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                {segment.text}
              </span>
            )}
            {index < segments.length - 1 && '\n'}
          </React.Fragment>
        ))}

        {/* Streaming indicator */}
        {isStreaming && (
          <span className="inline-flex items-center ml-1">
            <span className="animate-pulse">▌</span>
          </span>
        )}
      </div>

      {/* Source citations */}
      {diff.sources && diff.sources.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-fill-tert">
          <div className="text-xs text-text-muted mb-1">{t('aiAssist.sources')}</div>
          <div className="flex flex-wrap gap-2">
            {diff.sources.map((source) => (
              <SourceBadge key={source.index} source={source} />
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border bg-fill-tert">
        {isStreaming || status === 'thinking' || status === 'generating' ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Spinner className="h-4 w-4" />
            <span>
              {status === 'thinking'
                ? t('aiAssist.status.thinking')
                : status === 'generating'
                  ? t('aiAssist.status.generating')
                  : t('aiAssist.status.searching')}
            </span>
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={rejectDiff}
              className="h-8 text-text-muted hover:text-red-600"
            >
              <X className="h-4 w-4 mr-1" />
              {t('aiAssist.diff.reject')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={regenerate}
              className="h-8 text-text-muted hover:text-primary"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              {t('aiAssist.diff.regenerate')}
            </Button>
            <Button size="sm" onClick={acceptDiff} className="h-8">
              <Check className="h-4 w-4 mr-1" />
              {t('aiAssist.diff.accept')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Source citation badge component
 */
interface SourceBadgeProps {
  source: AIAssistSource
}

function SourceBadge({ source }: SourceBadgeProps) {
  const content = (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-surface border border-border rounded">
      <sup className="text-primary">[{source.index}]</sup>
      <span className="text-text-secondary truncate max-w-[150px]">{source.title}</span>
    </span>
  )

  if (source.url) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:opacity-80 transition-opacity"
      >
        {content}
      </a>
    )
  }

  return content
}

export default InlineDiff
