// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { AlertTriangle, Cloud, Clock, ExternalLink, FileText, Folder, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ExternalKbNode,
  ExternalKnowledgeBase,
  ExternalKnowledgeScope,
} from '@wecode/types/external-knowledge'
import { formatCompactDate, getOwnerLabel, isDocumentNode, isFolderNode } from '../utils'

export function ApReadonlyBadge() {
  const { t } = useTranslation('knowledge')
  return (
    <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-primary/20 bg-primary/10 px-2 text-xs font-medium text-primary">
      {t('external.ap.readonlyBadge')}
    </span>
  )
}

export function ScopeLabel({ scope }: { scope?: string | null }) {
  const { t } = useTranslation('knowledge')
  if (scope === 'personal') return <>{t('external.scope.personal')}</>
  if (scope === 'organization') return <>{t('external.scope.organization')}</>
  return <>{t('external.scope.all')}</>
}

export function ExternalKnowledgeToolbar({
  query,
  scope,
  onQueryChange,
  onScopeChange,
}: {
  query: string
  scope: ExternalKnowledgeScope
  onQueryChange: (value: string) => void
  onScopeChange: (value: ExternalKnowledgeScope) => void
}) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="relative w-full md:max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder={t('external.searchPlaceholder')}
          className="h-11 w-full rounded-lg border border-border bg-base pl-10 pr-3 text-sm outline-none ring-offset-base focus:ring-2 focus:ring-primary focus:ring-offset-2 md:h-10"
          data-testid="external-knowledge-search-input"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-secondary">{t('external.scope.label')}</span>
        <Select
          value={scope}
          onValueChange={value => onScopeChange(value as ExternalKnowledgeScope)}
        >
          <SelectTrigger
            className="h-11 min-w-[150px] md:h-10"
            data-testid="external-knowledge-scope-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('external.scope.all')}</SelectItem>
            <SelectItem value="personal">{t('external.scope.personal')}</SelectItem>
            <SelectItem value="organization">{t('external.scope.organization')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

export function ExternalKnowledgeCard({
  knowledgeBase,
  onOpen,
}: {
  knowledgeBase: ExternalKnowledgeBase
  onOpen: () => void
}) {
  const { t } = useTranslation('knowledge')
  const owner = getOwnerLabel(knowledgeBase)

  return (
    <Card
      padding="sm"
      className="group flex h-[168px] cursor-pointer flex-col transition-colors hover:bg-hover"
      onClick={onOpen}
      data-testid={`external-knowledge-card-${knowledgeBase.knowledge_base_id}`}
    >
      <div className="mb-2 flex items-start gap-2 pt-1">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
          <Cloud className="h-3.5 w-3.5" />
        </div>
        <h2 className="min-w-0 flex-1 text-sm font-semibold leading-relaxed text-text-primary line-clamp-2">
          {knowledgeBase.knowledge_base_name}
        </h2>
        <ApReadonlyBadge />
      </div>
      <div className="min-h-0 flex-1 text-xs text-text-muted">
        {knowledgeBase.description ? (
          <p className="line-clamp-2">{knowledgeBase.description}</p>
        ) : null}
      </div>
      <div className="mt-2 truncate text-xs text-text-secondary">
        <ScopeLabel scope={knowledgeBase.scope} />
        {owner ? ` · ${owner}` : ''}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {knowledgeBase.document_count ?? 0}
          </span>
          <span className="flex items-center gap-1" title={knowledgeBase.updated_at ?? ''}>
            <Clock className="h-3 w-3" />
            {formatCompactDate(knowledgeBase.updated_at)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 min-w-[44px] text-text-muted hover:text-primary md:h-8 md:w-8 md:min-w-8 md:opacity-0 md:group-hover:opacity-100"
            onClick={event => {
              event.stopPropagation()
              onOpen()
            }}
            data-testid={`external-knowledge-enter-button-${knowledgeBase.knowledge_base_id}`}
            aria-label={t('external.actions.enter')}
            title={t('external.actions.enter')}
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function ExternalKnowledgeWarning({
  message,
  onRetry,
}: {
  message?: string
  onRetry: () => void
}) {
  const { t } = useTranslation('knowledge')
  return (
    <Alert variant="warning" data-testid="external-knowledge-warning">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{message || t('external.status.unavailable')}</span>
        <Button
          type="button"
          variant="outline"
          className="h-11 min-w-[44px] self-start sm:h-9"
          onClick={onRetry}
          data-testid="external-knowledge-retry-button"
        >
          {t('external.actions.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function EmployeeRequiredCard() {
  const { t } = useTranslation('knowledge')
  return (
    <Card padding="lg" className="max-w-xl" data-testid="external-knowledge-employee-required">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Cloud className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-primary">
            {t('external.status.employeeRequiredTitle')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t('external.status.employeeRequiredDescription')}
          </p>
        </div>
      </div>
    </Card>
  )
}

export function KnowledgeCardSkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <Card
          key={index}
          padding="sm"
          className="h-[168px]"
          data-testid="external-knowledge-skeleton"
        >
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="h-6 w-6" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-6 w-16" />
          </div>
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <div className="mt-8 flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
          </div>
        </Card>
      ))}
    </div>
  )
}

export function NodeIcon({ node, className }: { node: ExternalKbNode; className?: string }) {
  if (isFolderNode(node)) {
    return <Folder className={cn('h-4 w-4 text-primary', className)} />
  }
  return <FileText className={cn('h-4 w-4 text-text-secondary', className)} />
}

export function NodeMeta({ node }: { node: ExternalKbNode }) {
  const pieces = [
    node.file_extension,
    node.file_size ? formatFileSize(node.file_size) : null,
  ].filter(Boolean)
  if (pieces.length === 0) return null
  return <span className="text-xs text-text-muted">{pieces.join(' · ')}</span>
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function EmptyState({
  title,
  description,
  testId,
}: {
  title: string
  description?: string
  testId: string
}) {
  return (
    <div
      className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface/40 px-4 text-center"
      data-testid={testId}
    >
      <Cloud className="mb-3 h-8 w-8 text-text-muted" />
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-md text-sm text-text-secondary">{description}</p>
      ) : null}
    </div>
  )
}

export function NodeListItem({
  node,
  selected,
  onClick,
}: {
  node: ExternalKbNode
  selected?: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('knowledge')
  const document = isDocumentNode(node)
  const disabled = document && node.previewable === false

  return (
    <button
      type="button"
      className={cn(
        'flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
        selected ? 'bg-primary/10 text-primary' : 'hover:bg-hover',
        disabled && 'cursor-not-allowed opacity-60'
      )}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? t('external.preview.unsupported') : undefined}
      data-testid={`external-knowledge-node-${node.node_id}`}
    >
      <NodeIcon node={node} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{node.name}</span>
        <NodeMeta node={node} />
      </span>
      {disabled ? (
        <span className="text-xs text-text-muted">{t('external.preview.unsupported')}</span>
      ) : null}
    </button>
  )
}
