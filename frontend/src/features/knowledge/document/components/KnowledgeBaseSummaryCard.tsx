// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { BookOpen, FileText, Info } from 'lucide-react'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface KnowledgeBaseSummaryCardProps {
  knowledgeBase: KnowledgeBase
}

/**
 * Knowledge Base Summary Card
 *
 * Displays knowledge base information as a system message-like card
 * at the top of the chat area. Shows:
 * - Knowledge base name and description
 * - Document count
 * - AI-generated summary (if available)
 *
 * Styled as a system message without avatar/sender info
 */
export function KnowledgeBaseSummaryCard({ knowledgeBase }: KnowledgeBaseSummaryCardProps) {
  const { t } = useTranslation('knowledge')

  const longSummary = knowledgeBase.summary?.long_summary
  const shortSummary = knowledgeBase.summary?.short_summary
  const topics = knowledgeBase.summary?.topics

  return (
    <div className="w-full max-w-3xl mx-auto mb-6">
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

        {/* Summary Section */}
        {(longSummary || shortSummary) && (
          <div className="pt-3 border-t border-border/50">
            <div className="flex items-center gap-2 mb-2">
              <Info className="w-4 h-4 text-text-muted" />
              <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                {t('chatPage.summary')}
              </span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">
              {longSummary || shortSummary}
            </p>
          </div>
        )}

        {/* Topics */}
        {topics && topics.length > 0 && (
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
  )
}
