// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export interface PromptDraftDiffLine {
  type: 'added' | 'removed' | 'unchanged'
  content: string
  lineNumber?: number
}

export interface PromptDraftDiffResult {
  lines: PromptDraftDiffLine[]
  added: number
  removed: number
  unchanged: number
}

function computeLcs(originalLines: string[], currentLines: string[]): string[] {
  const rows = originalLines.length
  const cols = currentLines.length
  const dp: number[][] = Array(rows + 1)
    .fill(null)
    .map(() => Array(cols + 1).fill(0))

  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      if (originalLines[row - 1] === currentLines[col - 1]) {
        dp[row][col] = dp[row - 1][col - 1] + 1
      } else {
        dp[row][col] = Math.max(dp[row - 1][col], dp[row][col - 1])
      }
    }
  }

  const result: string[] = []
  let row = rows
  let col = cols

  while (row > 0 && col > 0) {
    if (originalLines[row - 1] === currentLines[col - 1]) {
      result.unshift(originalLines[row - 1])
      row--
      col--
    } else if (dp[row - 1][col] >= dp[row][col - 1]) {
      row--
    } else {
      col--
    }
  }

  return result
}

export function buildPromptDraftDiff(
  originalPrompt: string,
  currentPrompt: string
): PromptDraftDiffResult {
  const originalLines = originalPrompt.split('\n')
  const currentLines = currentPrompt.split('\n')
  const lcs = computeLcs(originalLines, currentLines)
  const lines: PromptDraftDiffLine[] = []

  let originalIndex = 0
  let currentIndex = 0
  let lcsIndex = 0

  while (originalIndex < originalLines.length || currentIndex < currentLines.length) {
    const originalLine = originalLines[originalIndex]
    const currentLine = currentLines[currentIndex]
    const commonLine = lcs[lcsIndex]

    if (commonLine !== undefined && originalLine === commonLine && currentLine === commonLine) {
      lines.push({ type: 'unchanged', content: commonLine, lineNumber: currentIndex + 1 })
      originalIndex++
      currentIndex++
      lcsIndex++
      continue
    }

    if (currentLine !== undefined && currentLine !== commonLine) {
      lines.push({ type: 'added', content: currentLine, lineNumber: currentIndex + 1 })
      currentIndex++
      continue
    }

    if (originalLine !== undefined) {
      lines.push({ type: 'removed', content: originalLine })
      originalIndex++
      continue
    }

    break
  }

  return {
    lines,
    added: lines.filter(line => line.type === 'added').length,
    removed: lines.filter(line => line.type === 'removed').length,
    unchanged: lines.filter(line => line.type === 'unchanged').length,
  }
}

export interface PromptDraftDiffViewProps {
  originalPrompt: string
  currentPrompt: string
  className?: string
  showLineNumbers?: boolean
}

export function PromptDraftDiffView({
  originalPrompt,
  currentPrompt,
  className,
  showLineNumbers = true,
}: PromptDraftDiffViewProps) {
  const { t } = useTranslation('pet')
  const diff = useMemo(
    () => buildPromptDraftDiff(originalPrompt, currentPrompt),
    [originalPrompt, currentPrompt]
  )

  if (diff.lines.length === 0) {
    return (
      <div
        className={cn('p-4 text-center text-sm text-text-muted', className)}
        data-testid="prompt-draft-diff-empty"
      >
        {t('promptDraft.compare.noChanges') || 'No changes'}
      </div>
    )
  }

  return (
    <div className={cn('overflow-hidden rounded-md border border-border', className)}>
      {diff.lines.map((line, index) => (
        <div
          key={`${line.type}-${index}`}
          className={cn(
            'border-l-4 px-3 py-1 font-mono text-sm whitespace-pre-wrap',
            line.type === 'added' &&
              'border-l-green-500 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-200',
            line.type === 'removed' &&
              'border-l-red-500 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200',
            line.type === 'unchanged' && 'border-l-transparent bg-transparent text-text-primary'
          )}
          data-diff-type={line.type}
          data-testid="prompt-draft-diff-line"
        >
          <span className="mr-2 inline-block w-6 select-none text-xs text-text-muted">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          {showLineNumbers && line.lineNumber ? (
            <span className="mr-2 inline-block w-8 select-none text-xs text-text-muted">
              {line.lineNumber}
            </span>
          ) : null}
          <span>{line.content || ' '}</span>
        </div>
      ))}
    </div>
  )
}
