// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import {
  CheckCircle,
  AlertCircle,
  BarChart3,
  FileText,
  RefreshCw,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import MessageBubble, { Message } from './message/MessageBubble'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { CorrectionResponse, correctionApis } from '@/apis/correction'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'

interface CorrectionResultPanelProps {
  result: CorrectionResponse
  isLoading?: boolean
  className?: string
  onRetry?: () => void
  onApply?: (improvedAnswer: string) => void
  subtaskId?: number
}

function ScoreBar({ score, label }: { score: number; label: string }) {
  const getScoreColor = (score: number) => {
    if (score >= 8) return 'bg-green-500'
    if (score >= 6) return 'bg-yellow-500'
    if (score >= 4) return 'bg-orange-500'
    return 'bg-red-500'
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-text-secondary w-16 flex-shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', getScoreColor(score))}
          style={{ width: `${score * 10}%` }}
        />
      </div>
      <span className="text-sm font-medium w-10 text-right">{score}/10</span>
    </div>
  )
}

export default function CorrectionResultPanel({
  result,
  isLoading = false,
  className,
  onRetry,
  onApply,
  subtaskId,
}: CorrectionResultPanelProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { theme } = useTheme()
  const [isApplying, setIsApplying] = useState(false)
  // Initialize isApplied from result.applied (persisted state from backend)
  const [isApplied, setIsApplied] = useState(result.applied ?? false)
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)

  // Sync isApplied state when result.applied changes (e.g., when data is reloaded or re-validated)
  useEffect(() => {
    setIsApplied(result.applied ?? false)
  }, [result.applied])

  // Handle apply correction
  const handleApply = async () => {
    if (!result.improved_answer || !subtaskId) return

    setIsApplying(true)
    try {
      await correctionApis.applyCorrection(subtaskId, result.improved_answer)
      setIsApplied(true)
      toast({
        title: t('chat:correction.apply_success'),
      })
      // Call the onApply callback if provided
      if (onApply) {
        onApply(result.improved_answer)
      }
    } catch (error) {
      console.error('Failed to apply correction:', error)
      toast({
        variant: 'destructive',
        title: t('chat:correction.apply_failed'),
        description: (error as Error)?.message || 'Unknown error',
      })
    } finally {
      setIsApplying(false)
    }
  }

  if (isLoading) {
    return (
      <div className={cn('bg-surface rounded-xl border border-border p-4', className)}>
        {/* <div className="flex items-center gap-2 mb-4">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
          <span className="text-sm text-text-secondary">{t('chat:correction.evaluating')}</span>
        </div> */}
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-6 bg-border/50 rounded animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  const improvedMessage: Message = {
    type: 'ai',
    content: result.improved_answer || t('chat:correction.no_improvement_needed'),
    timestamp: Date.now(),
    botName: t('chat:correction.result_title'),
    subtaskStatus: 'COMPLETED',
    subtaskId: subtaskId,
  }

  return (
    <div
      className={cn(
        'bg-surface/50 rounded-xl border-2 border-primary/20 overflow-hidden flex flex-col h-full group',
        className
      )}
    >
      {/* Main Content: Improved Answer */}
      <div className="relative">
        {result.improved_answer ? (
          <MessageBubble
            msg={improvedMessage}
            index={0}
            selectedTaskDetail={null}
            theme={theme as 'light' | 'dark'}
            t={t}
            // Hide standard bubble border/background to blend with panel
            isCurrentUserMessage={false}
            feedbackMessageType="correction"
          />
        ) : (
          <div className="p-5 text-text-secondary text-sm italic">
            {t('chat:correction.no_improvement_needed')}
          </div>
        )}

        {/* Action Buttons Overlay - positioned similarly to MessageBubble actions but custom */}
        {subtaskId && result.improved_answer && (
          <div className="absolute top-4 right-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant={isApplied ? 'outline' : 'default'}
              size="sm"
              onClick={handleApply}
              disabled={isApplying || isApplied}
              className={cn(
                'h-7 text-xs px-2 shadow-sm',
                isApplied && 'text-green-600 border-green-600 hover:text-green-700'
              )}
            >
              {isApplying ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  {t('chat:correction.applying')}
                </>
              ) : isApplied ? (
                <>
                  <Check className="h-3 w-3 mr-1" />
                  {t('chat:correction.applied')}
                </>
              ) : (
                <>
                  <Check className="h-3 w-3 mr-1" />
                  {t('chat:correction.apply')}
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Collapsible Details Footer */}
      <div className="border-t border-border/50 bg-base/30 mt-auto">
        <button
          onClick={() => setIsDetailsOpen(!isDetailsOpen)}
          className="w-full flex items-center justify-center p-2 text-xs text-text-secondary hover:text-primary transition-colors focus:outline-none"
        >
          <span className="mr-1">
            {isDetailsOpen
              ? t('chat:correction.hide_details') || 'Hide Evaluation Details'
              : t('chat:correction.show_details') || 'Show Evaluation (Scores & Issues)'}
          </span>
          {isDetailsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {isDetailsOpen && (
          <div className="p-4 space-y-5 animate-in slide-in-from-top-2 duration-200 border-t border-border/30">
            {/* Scores Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <BarChart3 className="h-4 w-4 text-text-secondary" />
                <span>{t('chat:correction.scores')}</span>
              </div>
              <div className="space-y-2 pl-6">
                <ScoreBar score={result.scores.accuracy} label={t('chat:correction.accuracy')} />
                <ScoreBar score={result.scores.logic} label={t('chat:correction.logic')} />
                <ScoreBar
                  score={result.scores.completeness}
                  label={t('chat:correction.completeness')}
                />
              </div>
            </div>

            {/* Corrections Section */}
            {result.corrections.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <AlertCircle className="h-4 w-4 text-orange-500" />
                  <span>{t('chat:correction.issues_found')}</span>
                </div>
                <div className="space-y-2 pl-6">
                  {result.corrections.map((correction, index) => (
                    <div
                      key={index}
                      className="bg-orange-50 dark:bg-orange-950/20 rounded-lg p-3 text-sm"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-orange-600 dark:text-orange-400 font-medium flex-shrink-0">
                          {index + 1}.
                        </span>
                        <div className="space-y-1">
                          <p className="text-text-primary">{correction.issue}</p>
                          <p className="text-text-secondary">
                            <span className="text-green-600 dark:text-green-400 font-medium">
                              →{' '}
                            </span>
                            {correction.suggestion}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* No Corrections Needed */}
            {result.is_correct && result.corrections.length === 0 && (
              <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/20 rounded-lg ml-6">
                <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                <span className="text-sm text-green-700 dark:text-green-300">
                  {t('chat:correction.no_corrections_needed')}
                </span>
              </div>
            )}

            {/* Summary Section */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <FileText className="h-4 w-4 text-text-secondary" />
                <span>{t('chat:correction.summary')}</span>
              </div>
              <div className="pl-6 text-sm text-text-secondary">{result.summary}</div>
            </div>

            {/* Actions Footer */}
            {onRetry && (
              <div className="pt-2 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRetry}
                  disabled={isLoading}
                  className="h-8 text-xs text-text-secondary hover:text-primary"
                >
                  <RefreshCw className={cn('h-3 w-3 mr-1', isLoading && 'animate-spin')} />
                  {t('chat:correction.retry_evaluation')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
