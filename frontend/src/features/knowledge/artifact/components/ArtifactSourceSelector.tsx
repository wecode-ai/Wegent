// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Database, FileText, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useDocuments } from '@/features/knowledge/document/hooks/useDocuments'
import type { KnowledgeDocument } from '@/types/knowledge'

export type ArtifactSourceScope = { mode: 'all' } | { mode: 'selected'; documentIds: Set<number> }

interface ArtifactSourceSelectorProps {
  knowledgeBaseId: number
  scope: ArtifactSourceScope
  availableDocumentCount: number | null
  processingDocumentCount?: number
  active?: boolean
  compact?: boolean
  defaultDocumentsExpanded?: boolean
  onScopeChange: (scope: ArtifactSourceScope) => void
  onOpenDocument?: (document: KnowledgeDocument) => void
}

const canUseAsArtifactSource = (document: KnowledgeDocument) =>
  document.is_active && document.index_status === 'success'

const getSourceStatusKey = (document: KnowledgeDocument) => {
  if (!document.is_active) {
    return 'unavailable'
  }
  return document.index_status
}

export function ArtifactSourceSelector({
  knowledgeBaseId,
  scope,
  availableDocumentCount,
  processingDocumentCount = 0,
  active = true,
  compact = false,
  defaultDocumentsExpanded,
  onScopeChange,
  onOpenDocument,
}: ArtifactSourceSelectorProps) {
  const { t } = useTranslation('knowledge')
  const [searchQuery, setSearchQuery] = useState('')
  const [documentsExpanded, setDocumentsExpanded] = useState(false)
  const expansionInitializedRef = useRef(false)
  const previousKnowledgeBaseIdRef = useRef(knowledgeBaseId)
  const previousAvailableDocumentCountRef = useRef(availableDocumentCount)
  const selectedDocumentIds = scope.mode === 'selected' ? scope.documentIds : new Set<number>()
  const { documents, loading, error, page, pageSize, totalCount, totalPages, goToPage, refresh } =
    useDocuments({
      knowledgeBaseId,
      autoLoad: active && documentsExpanded,
      paginationEnabled: true,
      serverPaginationOnly: true,
      initialPageSize: 20,
      loadAll: false,
      keyword: searchQuery,
      sortBy: 'name',
      sortOrder: 'asc',
    })

  useEffect(() => {
    setSearchQuery('')
    expansionInitializedRef.current = false
    setDocumentsExpanded(false)
  }, [knowledgeBaseId])

  useEffect(() => {
    if (defaultDocumentsExpanded === undefined || expansionInitializedRef.current) return
    expansionInitializedRef.current = true
    setDocumentsExpanded(defaultDocumentsExpanded)
  }, [defaultDocumentsExpanded])

  useEffect(() => {
    if (!active || !documentsExpanded) {
      previousKnowledgeBaseIdRef.current = knowledgeBaseId
      previousAvailableDocumentCountRef.current = availableDocumentCount
      return
    }
    if (previousKnowledgeBaseIdRef.current !== knowledgeBaseId) {
      previousKnowledgeBaseIdRef.current = knowledgeBaseId
      previousAvailableDocumentCountRef.current = availableDocumentCount
      return
    }
    const previousCount = previousAvailableDocumentCountRef.current
    previousAvailableDocumentCountRef.current = availableDocumentCount
    if (previousCount !== null && previousCount !== availableDocumentCount) {
      void refresh()
    }
  }, [active, availableDocumentCount, documentsExpanded, knowledgeBaseId, refresh])

  useEffect(() => {
    if (!active || !documentsExpanded) return
    const handleFocus = () => void refresh()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [active, documentsExpanded, refresh])

  useEffect(() => {
    if (!active || !documentsExpanded || processingDocumentCount <= 0) return
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [active, documentsExpanded, processingDocumentCount, refresh])

  const toggleDocument = (documentId: number, checked: boolean) => {
    const next = new Set(selectedDocumentIds)
    if (checked) next.add(documentId)
    else next.delete(documentId)
    onScopeChange(next.size > 0 ? { mode: 'selected', documentIds: next } : { mode: 'all' })
  }

  const toggleDocumentsExpanded = () => {
    expansionInitializedRef.current = true
    setDocumentsExpanded(current => !current)
  }

  return (
    <div className="grid min-h-0 gap-2" data-testid="artifact-source-selector">
      <button
        type="button"
        className={`flex min-h-11 items-center gap-3 rounded-xl border text-left transition-colors ${
          compact ? 'px-3 py-2' : 'p-4'
        } ${scope.mode === 'all' ? 'border-primary bg-primary/5' : 'border-border hover:bg-hover'}`}
        onClick={() => onScopeChange({ mode: 'all' })}
        data-testid="artifact-source-all"
      >
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Database className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('artifact.sourceDialog.all')}</span>
            {scope.mode === 'all' && <Check className="h-4 w-4 shrink-0 text-primary" />}
          </div>
          <p className="truncate text-xs text-text-secondary">
            {t('artifact.sourceDialog.allHint', {
              count: availableDocumentCount ?? 0,
            })}
          </p>
        </div>
      </button>

      <div
        className={`flex min-h-0 flex-col rounded-xl border ${
          scope.mode === 'selected' ? 'border-primary' : 'border-border'
        }`}
      >
        <button
          type="button"
          className={`flex min-h-11 items-center gap-3 text-left ${compact ? 'px-3 py-2' : 'p-4'}`}
          onClick={toggleDocumentsExpanded}
          data-testid="artifact-source-selected"
          aria-expanded={documentsExpanded}
        >
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <FileText className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {t(compact ? 'artifact.sourceBrowser.documents' : 'artifact.sourceDialog.selected')}
              </span>
              {documentsExpanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 rotate-180 text-text-muted transition-transform" />
              ) : compact ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-text-muted transition-transform" />
              ) : (
                scope.mode === 'selected' && <Check className="h-4 w-4 shrink-0 text-primary" />
              )}
            </div>
            <p className="truncate text-xs text-text-secondary">
              {scope.mode === 'all' && compact
                ? t('artifact.sourceBrowser.selectHint')
                : t('artifact.sourceDialog.selectedHint', {
                    count: selectedDocumentIds.size,
                  })}
            </p>
          </div>
        </button>

        {documentsExpanded && (
          <div className="flex min-h-0 flex-col border-t border-border p-2">
            {selectedDocumentIds.size > 0 && (
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-text-secondary">
                <span>
                  {t('artifact.sourceDialog.selectedHint', {
                    count: selectedDocumentIds.size,
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => onScopeChange({ mode: 'all' })}
                  data-testid="artifact-source-clear"
                >
                  {t('artifact.sourceDialog.clear')}
                </Button>
              </div>
            )}
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <Input
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={t('artifact.sourceDialog.search')}
                className="h-10 pl-9"
                data-testid="artifact-source-search"
              />
            </div>

            <div className={`${compact ? 'max-h-36' : 'max-h-72'} space-y-1 overflow-auto`}>
              {loading ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : error ? (
                <p className="py-8 text-center text-sm text-error">{error}</p>
              ) : documents.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-secondary">
                  {t('artifact.sourceDialog.empty')}
                </p>
              ) : (
                documents.map(document => {
                  const eligible = canUseAsArtifactSource(document)
                  const isSelected = selectedDocumentIds.has(document.id)
                  const canToggle = eligible || isSelected
                  return (
                    <div
                      key={document.id}
                      className={`flex min-h-11 items-center gap-2 rounded-lg px-2 ${
                        canToggle ? 'hover:bg-hover' : 'opacity-60'
                      }`}
                    >
                      <Checkbox
                        checked={isSelected}
                        disabled={!canToggle}
                        onCheckedChange={checked => toggleDocument(document.id, checked === true)}
                        data-testid={`artifact-source-document-${document.id}`}
                        aria-label={document.name}
                      />
                      <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                      {onOpenDocument ? (
                        <button
                          type="button"
                          className="min-h-11 min-w-0 flex-1 truncate text-left text-sm hover:text-primary"
                          onClick={() => onOpenDocument(document)}
                          data-testid={`artifact-source-open-document-${document.id}`}
                        >
                          {document.name}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm">{document.name}</span>
                      )}
                      {!eligible && (
                        <span className="shrink-0 text-xs text-text-muted">
                          {t(`artifact.sourceDialog.status.${getSourceStatusKey(document)}`)}
                        </span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            {totalCount > pageSize && (
              <Pagination
                page={page}
                totalPages={totalPages}
                totalCount={totalCount}
                pageSize={pageSize}
                onGoToPage={goToPage}
                showPageSizeSelector={false}
                disabled={loading}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
