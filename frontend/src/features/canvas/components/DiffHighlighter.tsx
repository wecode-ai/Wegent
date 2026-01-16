// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { memo } from 'react'
import { cn } from '@/lib/utils'
import type { DiffSegment } from '../utils/diff'

interface DiffHighlighterProps {
  /** Diff segments to render */
  segments: DiffSegment[]
  /** Whether animation is currently playing */
  isAnimating: boolean
  /** Additional class name */
  className?: string
  /** Whether content is code (uses monospace font) */
  isCode?: boolean
}

/**
 * DiffHighlighter - Renders content with change highlighting animations
 *
 * Takes diff segments and renders them with appropriate highlighting.
 * When isAnimating is true, added segments will have pulse animation.
 */
export const DiffHighlighter = memo(function DiffHighlighter({
  segments,
  isAnimating,
  className,
  isCode = false,
}: DiffHighlighterProps) {
  if (segments.length === 0) {
    return null
  }

  // If not animating and all segments are unchanged, render plain text
  const allUnchanged = segments.every(s => s.type === 'unchanged')
  if (!isAnimating && allUnchanged) {
    const fullText = segments.map(s => s.text).join('')
    return (
      <span className={cn(isCode && 'font-mono', className)}>
        {fullText}
      </span>
    )
  }

  return (
    <span className={cn(isCode && 'font-mono', className)}>
      {segments.map((segment, index) => {
        const key = `${index}-${segment.type}-${segment.text.slice(0, 20)}`

        switch (segment.type) {
          case 'unchanged':
            return (
              <span key={key}>
                {segment.text}
              </span>
            )

          case 'added':
            return (
              <span
                key={key}
                className={cn(
                  'diff-highlight',
                  isAnimating
                    ? 'diff-highlight-pulse-added'
                    : 'diff-highlight-added'
                )}
              >
                {segment.text}
              </span>
            )

          case 'removed':
            // For removed content, show with strikethrough during animation
            // then hide after animation completes
            if (!isAnimating) {
              return null
            }
            return (
              <span
                key={key}
                className="diff-highlight diff-highlight-removed"
              >
                {segment.text}
              </span>
            )

          default:
            return (
              <span key={key}>
                {segment.text}
              </span>
            )
        }
      })}
    </span>
  )
})

/**
 * Simple wrapper for code content with diff highlighting
 */
export const CodeDiffHighlighter = memo(function CodeDiffHighlighter(
  props: Omit<DiffHighlighterProps, 'isCode'>
) {
  return <DiffHighlighter {...props} isCode />
})

/**
 * Pre-formatted code block with diff highlighting
 */
interface CodeBlockDiffHighlighterProps extends Omit<DiffHighlighterProps, 'isCode'> {
  /** Code block wrapper class */
  wrapperClassName?: string
}

export const CodeBlockDiffHighlighter = memo(function CodeBlockDiffHighlighter({
  segments,
  isAnimating,
  className,
  wrapperClassName,
}: CodeBlockDiffHighlighterProps) {
  return (
    <pre className={cn('text-sm font-mono bg-muted/30 p-3 rounded h-full overflow-auto', wrapperClassName)}>
      <code className={cn('text-text-primary whitespace-pre-wrap break-words', className)}>
        <DiffHighlighter
          segments={segments}
          isAnimating={isAnimating}
          isCode
        />
      </code>
    </pre>
  )
})

/**
 * Text content with diff highlighting
 */
export const TextDiffHighlighter = memo(function TextDiffHighlighter({
  segments,
  isAnimating,
  className,
}: DiffHighlighterProps) {
  return (
    <div className={cn('text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed', className)}>
      <DiffHighlighter
        segments={segments}
        isAnimating={isAnimating}
      />
    </div>
  )
})
