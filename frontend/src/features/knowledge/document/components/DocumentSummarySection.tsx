// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import type { DocumentDetailResponse } from '@/types/knowledge'

interface DocumentSummarySectionProps {
  summary: DocumentDetailResponse['summary']
  onRefresh: () => void
}

export function DocumentSummarySection({ summary, onRefresh }: DocumentSummarySectionProps) {
  const { t } = useTranslation('knowledge')

  if (!summary) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-primary">
          {t('document.document.detail.summary')}
        </h3>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Summary Status */}
      {summary.status && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{t('document.document.detail.status')}:</span>
          <Badge
            variant={
              summary.status === 'completed'
                ? 'success'
                : summary.status === 'generating'
                  ? 'warning'
                  : 'default'
            }
            size="sm"
          >
            {t(`document.document.detail.statusValues.${summary.status}`)}
          </Badge>
        </div>
      )}

      {/* Short Summary */}
      {summary.short_summary && (
        <div className="p-3 bg-surface rounded-lg">
          <p className="text-sm text-text-primary">{summary.short_summary}</p>
        </div>
      )}

      {/* Long Summary */}
      {summary.long_summary && (
        <div className="p-3 bg-surface rounded-lg">
          <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
            {summary.long_summary}
          </p>
        </div>
      )}

      {/* Topics */}
      {summary.topics && summary.topics.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs text-text-muted">{t('document.document.detail.topics')}:</span>
          <div className="flex flex-wrap gap-2">
            {summary.topics.map((topic, index) => (
              <Badge key={index} variant="secondary" size="sm">
                {topic}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
