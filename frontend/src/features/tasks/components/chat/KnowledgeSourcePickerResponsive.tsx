// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { TruncatedText } from '@/components/common/long-text'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface KnowledgeSourcePickerLayoutProps {
  hasDocumentView: boolean
  sourceColumn: React.ReactNode
  knowledgeBaseColumn: React.ReactNode
  documentColumn: React.ReactNode
  onBack: () => void
}

export function KnowledgeSourcePickerLayout({
  hasDocumentView,
  sourceColumn,
  knowledgeBaseColumn,
  documentColumn,
  onBack,
}: KnowledgeSourcePickerLayoutProps) {
  const { t } = useTranslation('knowledge')

  return (
    <div
      className={cn(
        'grid h-full min-h-0 grid-cols-1 overflow-hidden',
        'md:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)] md:grid-rows-[auto_minmax(0,1fr)]',
        'lg:h-[min(520px,calc(var(--radix-popover-content-available-height,592px)-72px))] lg:grid-cols-[180px_220px_minmax(0,1fr)] lg:grid-rows-1',
        hasDocumentView ? 'grid-rows-1' : 'grid-rows-[auto_minmax(0,1fr)]'
      )}
      data-testid="knowledge-source-picker"
    >
      <div
        className={cn(
          'min-h-0 border-b border-border md:col-start-1 md:row-start-1 md:block md:border-r lg:col-auto lg:row-auto lg:border-b-0',
          hasDocumentView && 'hidden md:block'
        )}
        data-testid="knowledge-picker-source-column"
      >
        <div className="h-full min-h-0 overflow-y-auto">{sourceColumn}</div>
      </div>

      <div
        className={cn(
          'min-h-0 border-b border-border md:col-start-1 md:row-start-2 md:block md:border-b-0 md:border-r lg:col-auto lg:row-auto',
          hasDocumentView && 'hidden md:block'
        )}
        data-testid="knowledge-picker-knowledge-base-column"
      >
        <div className="h-full min-h-0 overflow-y-auto">{knowledgeBaseColumn}</div>
      </div>

      <div
        className={cn(
          'min-h-0 overflow-hidden md:col-start-2 md:row-span-2 md:row-start-1 md:flex md:flex-col lg:col-auto lg:row-auto lg:row-span-1',
          hasDocumentView ? 'flex flex-col' : 'hidden'
        )}
        data-testid="knowledge-picker-document-column"
      >
        {hasDocumentView ? (
          <button
            type="button"
            className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-sm font-medium text-text-primary md:hidden"
            onClick={onBack}
            data-testid="knowledge-picker-mobile-back"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('document.backToList')}
          </button>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">{documentColumn}</div>
      </div>
    </div>
  )
}

export function ResponsiveSecondaryOptions({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}) {
  return (
    <div
      className="space-y-1 p-2 lg:hidden"
      data-testid={`knowledge-picker-responsive-${testId}-options`}
    >
      <div className="px-3 pb-2 pt-1 text-xs font-medium text-text-muted">{title}</div>
      {children}
    </div>
  )
}

export function ResponsiveSecondaryOption({
  icon: Icon,
  label,
  count,
  onClick,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count?: number
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-text-primary hover:bg-surface"
      onClick={onClick}
      data-testid={testId}
    >
      <Icon className="h-4 w-4 shrink-0 text-text-muted" />
      <TruncatedText
        text={label}
        focusable={false}
        className="min-w-0 flex-1 text-sm font-medium"
      />
      {count !== undefined ? (
        <Badge variant="secondary" size="sm">
          {count}
        </Badge>
      ) : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
    </button>
  )
}

export function ResponsiveDrilldownHeader({
  label,
  onBack,
  testId,
}: {
  label: string
  onBack: () => void
  testId: string
}) {
  const { t } = useTranslation('knowledge')

  return (
    <button
      type="button"
      className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-left text-sm font-medium text-text-primary hover:bg-surface lg:hidden"
      onClick={onBack}
      aria-label={t('picker.changeSelection', { name: label })}
      data-testid={testId}
    >
      <ChevronLeft className="h-4 w-4 shrink-0" />
      <TruncatedText text={label} focusable={false} className="min-w-0 flex-1" />
    </button>
  )
}
