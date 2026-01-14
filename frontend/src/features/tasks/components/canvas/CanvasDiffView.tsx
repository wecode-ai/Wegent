// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas diff view component for showing AI modifications.
 * Highlights changes between old and new content.
 */

'use client'

import React, { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CheckIcon, XIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CanvasDiffInfo } from '@/types/canvas'

interface CanvasDiffViewProps {
  diffInfo: CanvasDiffInfo
  onAccept: () => void
  onReject: () => void
  className?: string
}

interface DiffLine {
  type: 'unchanged' | 'added' | 'removed'
  content: string
  lineNumber?: number
}

export function CanvasDiffView({ diffInfo, onAccept, onReject, className }: CanvasDiffViewProps) {
  const { t } = useTranslation('canvas')

  // Simple diff algorithm that highlights changed sections
  const diffLines = useMemo(() => {
    const oldLines = diffInfo.oldContent.split('\n')
    const newLines = diffInfo.newContent.split('\n')
    const result: DiffLine[] = []

    // Find the position of the change
    const oldStr = diffInfo.oldStr
    const newStr = diffInfo.newStr

    // Get line ranges that contain the change
    let oldStart = 0
    let charCount = 0
    for (let i = 0; i < oldLines.length; i++) {
      const lineStart = charCount
      charCount += oldLines[i].length + 1 // +1 for newline
      if (diffInfo.oldContent.indexOf(oldStr) >= lineStart && diffInfo.oldContent.indexOf(oldStr) < charCount) {
        oldStart = i
        break
      }
    }

    // Find how many lines the old/new strings span
    const oldStrLines = oldStr.split('\n').length
    const newStrLines = newStr.split('\n').length

    // Build diff output
    let lineNum = 1

    // Lines before the change
    for (let i = 0; i < oldStart; i++) {
      result.push({ type: 'unchanged', content: oldLines[i], lineNumber: lineNum++ })
    }

    // Removed lines
    for (let i = oldStart; i < oldStart + oldStrLines && i < oldLines.length; i++) {
      result.push({ type: 'removed', content: oldLines[i] })
    }

    // Added lines (new content at the same position)
    const newStart = oldStart
    for (let i = newStart; i < newStart + newStrLines && i < newLines.length; i++) {
      result.push({ type: 'added', content: newLines[i], lineNumber: lineNum++ })
    }

    // Lines after the change (from new content)
    for (let i = newStart + newStrLines; i < newLines.length; i++) {
      result.push({ type: 'unchanged', content: newLines[i], lineNumber: lineNum++ })
    }

    return result
  }, [diffInfo])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Diff content */}
      <div className="flex-1 overflow-auto bg-surface border rounded-lg">
        <div className="font-mono text-sm">
          {diffLines.map((line, index) => (
            <div
              key={index}
              className={cn(
                'flex px-4 py-0.5 leading-6',
                line.type === 'added' && 'bg-green-50 dark:bg-green-950/30',
                line.type === 'removed' && 'bg-red-50 dark:bg-red-950/30 line-through opacity-60'
              )}
            >
              {/* Line indicator */}
              <span
                className={cn(
                  'w-6 flex-shrink-0 text-center mr-2',
                  line.type === 'added' && 'text-green-600 dark:text-green-400',
                  line.type === 'removed' && 'text-red-600 dark:text-red-400',
                  line.type === 'unchanged' && 'text-text-muted'
                )}
              >
                {line.type === 'added' && '+'}
                {line.type === 'removed' && '-'}
                {line.type === 'unchanged' && ' '}
              </span>

              {/* Line number */}
              {line.lineNumber && (
                <span className="w-8 flex-shrink-0 text-text-muted text-right mr-4">
                  {line.lineNumber}
                </span>
              )}
              {!line.lineNumber && <span className="w-8 flex-shrink-0 mr-4" />}

              {/* Content */}
              <span
                className={cn(
                  'flex-1 whitespace-pre-wrap break-all',
                  line.type === 'added' && 'text-green-800 dark:text-green-200',
                  line.type === 'removed' && 'text-red-800 dark:text-red-200'
                )}
              >
                {line.content || ' '}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-3 py-3 px-4 border-t bg-surface">
        <Button variant="outline" size="sm" onClick={onReject} className="h-9">
          <XIcon className="h-4 w-4 mr-2" />
          {t('diff.reject')}
        </Button>
        <Button size="sm" onClick={onAccept} className="h-9">
          <CheckIcon className="h-4 w-4 mr-2" />
          {t('diff.accept')}
        </Button>
      </div>
    </div>
  )
}
