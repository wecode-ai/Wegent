// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { FileText, RotateCcw, History, Wand2, RefreshCw, GitCompare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface PromptComparePanelProps {
  originalPrompt: string
  currentPrompt: string
  onPromptChange: (prompt: string) => void
  onReset: () => void
  // New props for iterate functionality
  userFeedback?: string
  setUserFeedback?: (feedback: string) => void
  isIteratingPrompt?: boolean
  onIteratePrompt?: () => Promise<void>
  hasAiResponse?: boolean
}

// Simple line-based diff implementation
interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  content: string
  lineNumber?: number
}

function computeLineDiff(original: string, current: string): DiffLine[] {
  const originalLines = original.split('\n')
  const currentLines = current.split('\n')
  const result: DiffLine[] = []

  // Simple LCS-based diff algorithm
  const lcs = computeLCS(originalLines, currentLines)
  let origIdx = 0
  let currIdx = 0
  let lcsIdx = 0

  while (origIdx < originalLines.length || currIdx < currentLines.length) {
    if (
      lcsIdx < lcs.length &&
      origIdx < originalLines.length &&
      originalLines[origIdx] === lcs[lcsIdx]
    ) {
      // Check if current also matches
      if (currIdx < currentLines.length && currentLines[currIdx] === lcs[lcsIdx]) {
        result.push({ type: 'unchanged', content: lcs[lcsIdx], lineNumber: currIdx + 1 })
        origIdx++
        currIdx++
        lcsIdx++
      } else if (currIdx < currentLines.length) {
        // Current line is added
        result.push({ type: 'added', content: currentLines[currIdx], lineNumber: currIdx + 1 })
        currIdx++
      } else {
        // Original line is removed
        result.push({ type: 'removed', content: originalLines[origIdx] })
        origIdx++
      }
    } else if (
      origIdx < originalLines.length &&
      (lcsIdx >= lcs.length || originalLines[origIdx] !== lcs[lcsIdx])
    ) {
      // Original line is removed
      result.push({ type: 'removed', content: originalLines[origIdx] })
      origIdx++
    } else if (currIdx < currentLines.length) {
      // Current line is added
      result.push({ type: 'added', content: currentLines[currIdx], lineNumber: currIdx + 1 })
      currIdx++
    }
  }

  return result
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = []
  let i = m,
    j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1])
      i--
      j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  return lcs
}

export default function PromptComparePanel({
  originalPrompt,
  currentPrompt,
  onPromptChange,
  onReset,
  userFeedback = '',
  setUserFeedback,
  isIteratingPrompt = false,
  onIteratePrompt,
  hasAiResponse = false,
}: PromptComparePanelProps) {
  const { t } = useTranslation('wizard')
  const [activeTab, setActiveTab] = useState<'current' | 'original' | 'diff'>('current')

  // Check if prompt has been modified
  const isModified = useMemo(() => {
    return originalPrompt !== currentPrompt
  }, [originalPrompt, currentPrompt])

  // Compute diff when needed
  const diffLines = useMemo(() => {
    if (!isModified) return []
    return computeLineDiff(originalPrompt, currentPrompt)
  }, [originalPrompt, currentPrompt, isModified])

  const handleIterateSubmit = async () => {
    if (!userFeedback?.trim() || isIteratingPrompt || !onIteratePrompt) return
    await onIteratePrompt()
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab Header */}
      <div className="flex items-center justify-between p-3 border-b border-border flex-shrink-0 gap-2">
        <div className="flex items-center gap-1 flex-nowrap overflow-x-auto min-w-0">
          <button
            onClick={() => setActiveTab('current')}
            className={cn(
              'flex items-center gap-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
              activeTab === 'current'
                ? 'bg-primary/10 text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-muted'
            )}
          >
            <FileText className="w-3.5 h-3.5 flex-shrink-0" />
            {t('promptTune:compare.current')}
            {isModified && (
              <span className="text-xs bg-primary/20 px-1 py-0.5 rounded flex-shrink-0">
                {t('promptTune:compare.modified')}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('original')}
            className={cn(
              'flex items-center gap-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
              activeTab === 'original'
                ? 'bg-primary/10 text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-muted'
            )}
          >
            <History className="w-3.5 h-3.5 flex-shrink-0" />
            {t('promptTune:compare.original')}
          </button>
          {isModified && (
            <button
              onClick={() => setActiveTab('diff')}
              className={cn(
                'flex items-center gap-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                activeTab === 'diff'
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-muted hover:text-text-primary hover:bg-muted'
              )}
            >
              <GitCompare className="w-3.5 h-3.5 flex-shrink-0" />
              {t('promptTune:compare.diff')}
            </button>
          )}
        </div>
        {isModified && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7 text-xs text-text-muted hover:text-text-primary flex-shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            {t('promptTune:actions.reset')}
          </Button>
        )}
      </div>

      {/* Prompt Content Area */}
      <div className="flex-1 p-3 overflow-hidden flex flex-col min-h-0">
        {activeTab === 'current' ? (
          <Textarea
            value={currentPrompt}
            onChange={e => onPromptChange(e.target.value)}
            className="flex-1 min-h-0 font-mono text-sm resize-none"
            placeholder={t('wizard:system_prompt_placeholder')}
          />
        ) : activeTab === 'original' ? (
          <div className="flex-1 min-h-0 overflow-y-auto bg-muted/50 rounded-md p-3 font-mono text-sm text-text-muted whitespace-pre-wrap">
            {originalPrompt || t('wizard:system_prompt_placeholder')}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border">
            {diffLines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  'px-3 py-0.5 font-mono text-sm whitespace-pre-wrap border-l-4',
                  line.type === 'added' &&
                    'bg-green-50 dark:bg-green-950/30 border-l-green-500 text-green-800 dark:text-green-200',
                  line.type === 'removed' &&
                    'bg-red-50 dark:bg-red-950/30 border-l-red-500 text-red-800 dark:text-red-200',
                  line.type === 'unchanged' &&
                    'bg-transparent border-l-transparent text-text-primary'
                )}
              >
                <span className="inline-block w-6 text-text-muted text-xs mr-2 select-none">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                {line.content || ' '}
              </div>
            ))}
            {diffLines.length === 0 && (
              <div className="p-4 text-center text-text-muted text-sm">
                {t('promptTune:compare.no_changes')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Iterate section - always show when iterate functionality is available */}
      {setUserFeedback && onIteratePrompt && (
        <div className="border-t border-border p-3 flex-shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-text-primary">
              {t('wizard:iterate_label')}
            </span>
          </div>
          <div className="flex gap-2">
            <Textarea
              value={userFeedback}
              onChange={e => setUserFeedback(e.target.value)}
              placeholder={t('wizard:iterate_placeholder')}
              className="min-h-[60px] flex-1 text-sm resize-none"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleIterateSubmit()
                }
              }}
            />
            <Button
              variant="primary"
              onClick={handleIterateSubmit}
              disabled={isIteratingPrompt || !userFeedback?.trim() || !hasAiResponse}
              title={!hasAiResponse ? t('wizard:iterate_need_test_first') : ''}
              className="self-end"
            >
              {isIteratingPrompt ? (
                <Spinner className="w-4 h-4" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
