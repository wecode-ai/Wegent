// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DocumentDetailResponse } from '@/types/knowledge'

interface DocumentSummarySectionProps {
  summary: DocumentDetailResponse['summary']
  onRefresh: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
  contentClassName?: string
}

export function DocumentSummarySection({
  summary,
  onRefresh,
  open,
  onOpenChange,
  className,
  contentClassName,
}: DocumentSummarySectionProps) {
  const { t } = useTranslation('knowledge')

  if (!summary) return null

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn('rounded-lg border border-border bg-base px-4 py-3', className)}
    >
      <div className="flex items-center justify-between">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start gap-2 px-0 hover:bg-transparent max-md:min-h-[44px]"
            data-testid="knowledge-document-summary-toggle"
          >
            {open ? (
              <ChevronUp className="h-4 w-4 flex-shrink-0 text-text-muted" />
            ) : (
              <ChevronDown className="h-4 w-4 flex-shrink-0 text-text-muted" />
            )}
            <span className="truncate text-sm font-medium text-text-primary">
              {t('document.document.detail.derivedSummary')}
            </span>
            {summary.status && (
              <Badge
                variant={
                  summary.status === 'completed'
                    ? 'success'
                    : summary.status === 'generating'
                      ? 'warning'
                      : 'default'
                }
                size="sm"
                className="flex-shrink-0"
              >
                {t(`document.document.detail.statusValues.${summary.status}`)}
              </Badge>
            )}
          </Button>
        </CollapsibleTrigger>
        {open && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            className="max-md:min-h-[44px] max-md:min-w-[44px]"
            aria-label={t('document.document.detail.refreshSummary')}
            data-testid="knowledge-document-summary-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <CollapsibleContent className={cn('mt-3 space-y-3', contentClassName)}>
        {summary.short_summary && (
          <div className="rounded-lg bg-surface p-3">
            <p className="text-sm text-text-primary">{summary.short_summary}</p>
          </div>
        )}

        {summary.long_summary && (
          <div className="rounded-lg bg-surface p-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
              {summary.long_summary}
            </p>
          </div>
        )}

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
      </CollapsibleContent>
    </Collapsible>
  )
}
