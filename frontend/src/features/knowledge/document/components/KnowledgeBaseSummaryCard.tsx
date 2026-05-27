// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { BookOpen, FileText, Info, AlertTriangle, RefreshCw, Pencil } from 'lucide-react'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EditKnowledgeBaseSummaryDialog } from './EditKnowledgeBaseSummaryDialog'
import { useKnowledgeBaseSummaryEditor } from '../hooks/useKnowledgeBaseSummaryEditor'
import {
  getEffectiveKnowledgeBaseLongSummary,
  hasManualSummaryOverride,
  shouldShowSummaryContent,
  shouldShowRetryButton,
} from '../utils/summarySelectors'

interface KnowledgeBaseSummaryCardProps {
  knowledgeBase: KnowledgeBase
  /** Callback to refresh knowledge base details after retry */
  onRefresh?: () => void
  canEditSummary?: boolean
}

/**
 * Knowledge Base Summary Card
 *
 * Displays knowledge base information as a system message-like card
 * at the top of the chat area. Shows:
 * - Knowledge base name and description
 * - Document count
 * - AI-generated summary (if available)
 * - Summary failure warning with retry button (if failed)
 *
 * Styled as a system message without avatar/sender info
 */
export function KnowledgeBaseSummaryCard({
  knowledgeBase,
  onRefresh,
  canEditSummary = false,
}: KnowledgeBaseSummaryCardProps) {
  const { t } = useTranslation('knowledge')
  const { isRetrying, retrySummary, openEditor, editorDialogProps } = useKnowledgeBaseSummaryEditor(
    {
      knowledgeBase,
      onRefresh,
    }
  )

  const effectiveLongSummary = getEffectiveKnowledgeBaseLongSummary(knowledgeBase.summary)
  const shortSummary = knowledgeBase.summary?.short_summary
  const topics = knowledgeBase.summary?.topics
  const summaryError = knowledgeBase.summary?.error
  const hasManual = hasManualSummaryOverride(knowledgeBase.summary)
  const showSummary = shouldShowSummaryContent(knowledgeBase.summary)
  const showRetry = shouldShowRetryButton(knowledgeBase.summary, knowledgeBase.summary_enabled)

  return (
    <>
      <div className="w-full max-w-3xl mx-auto mb-6 pt-6">
        <div className="bg-surface/50 border border-border rounded-xl p-5 space-y-4">
          {/* Header with icon and name */}
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-text-primary truncate">
                {knowledgeBase.name}
              </h3>
              {knowledgeBase.description && (
                <p className="text-sm text-text-muted mt-0.5 line-clamp-2">
                  {knowledgeBase.description}
                </p>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <div className="flex items-center gap-1.5">
              <FileText className="w-4 h-4" />
              <span>{t('document_count', { count: knowledgeBase.document_count })}</span>
            </div>
            {knowledgeBase.namespace !== 'default' && (
              <div className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs">
                {knowledgeBase.namespace}
              </div>
            )}
          </div>

          {/* Summary Section - show manual summary even when AI generation failed */}
          {(showSummary || canEditSummary) && (
            <div className="pt-3 border-t border-border/50">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Info className="w-4 h-4 text-text-muted" />
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                    {t('chatPage.summary')}
                  </span>
                  {hasManual && (
                    <Badge variant="secondary" size="sm">
                      {t('chatPage.summaryManualBadge')}
                    </Badge>
                  )}
                </div>
                {canEditSummary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={openEditor}
                    className="h-11 min-w-[44px] px-2 text-xs"
                    data-testid="kb-summary-edit-button"
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1.5" />
                    {t('chatPage.summaryEdit')}
                  </Button>
                )}
              </div>
              {showSummary ? (
                <p className="text-sm text-text-secondary leading-relaxed">
                  {effectiveLongSummary || shortSummary}
                </p>
              ) : (
                <p className="text-sm text-text-muted">{t('chatPage.summaryEditPlaceholder')}</p>
              )}
            </div>
          )}

          {/* Summary Failed Warning */}
          {showRetry && (
            <div className="pt-3 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertTriangle className="w-4 h-4 text-amber-500 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs">
                          {summaryError || t('chatPage.summaryFailedHint')}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span className="text-sm text-amber-500 font-medium">
                    {t('chatPage.summaryFailed')}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={retrySummary}
                  disabled={isRetrying}
                  className="h-11 min-w-[44px] text-xs"
                  data-testid="kb-summary-retry-button"
                >
                  <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} />
                  {isRetrying ? t('chatPage.summaryRetrying') : t('chatPage.summaryRetry')}
                </Button>
              </div>
            </div>
          )}

          {/* Topics - show even when AI failed if manual summary exists */}
          {topics && topics.length > 0 && showSummary && (
            <div className="flex flex-wrap gap-2">
              {topics.slice(0, 5).map((topic, index) => (
                <span
                  key={index}
                  className="px-2 py-1 text-xs rounded-md bg-muted text-text-secondary"
                >
                  {topic}
                </span>
              ))}
              {topics.length > 5 && (
                <span className="px-2 py-1 text-xs rounded-md bg-muted text-text-muted">
                  +{topics.length - 5}
                </span>
              )}
            </div>
          )}

          {/* Hint */}
          <p className="text-xs text-text-muted italic">{t('chatPage.contextHint')}</p>
        </div>
      </div>
      {canEditSummary && <EditKnowledgeBaseSummaryDialog {...editorDialogProps} />}
    </>
  )
}
