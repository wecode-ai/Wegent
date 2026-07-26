// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Check, Database, FileText, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useDocuments } from '@/features/knowledge/document/hooks/useDocuments'
import type { KnowledgeDocument } from '@/types/knowledge'

interface ArtifactSourceDialogProps {
  knowledgeBaseId: number
  open: boolean
  selectedDocumentIds: number[]
  availableDocumentCount: number | null
  onOpenChange: (open: boolean) => void
  onApply: (documentIds: number[]) => void
}

const canUseAsArtifactSource = (document: KnowledgeDocument) =>
  document.is_active && document.index_status === 'success'

const getSourceStatusKey = (document: KnowledgeDocument) => {
  if (!document.is_active) {
    return 'unavailable'
  }
  return document.index_status
}

export function ArtifactSourceDialog({
  knowledgeBaseId,
  open,
  selectedDocumentIds,
  availableDocumentCount,
  onOpenChange,
  onApply,
}: ArtifactSourceDialogProps) {
  const { t } = useTranslation('knowledge')
  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [draftIds, setDraftIds] = useState<Set<number>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const {
    documents,
    loading,
    error,
    page,
    pageSize,
    totalCount,
    totalPages,
    goToPage,
    changePageSize,
  } = useDocuments({
    knowledgeBaseId,
    autoLoad: open,
    paginationEnabled: true,
    loadAll: false,
    keyword: searchQuery,
    sortBy: 'name',
    sortOrder: 'asc',
  })

  useEffect(() => {
    if (!open) return
    setMode(selectedDocumentIds.length > 0 ? 'selected' : 'all')
    setDraftIds(new Set(selectedDocumentIds))
    setSearchQuery('')
  }, [open, selectedDocumentIds])

  const toggleDocument = (documentId: number, checked: boolean) => {
    setMode('selected')
    setDraftIds(current => {
      const next = new Set(current)
      if (checked) next.add(documentId)
      else next.delete(documentId)
      return next
    })
  }

  const handleApply = () => {
    onApply(mode === 'all' ? [] : Array.from(draftIds))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80vh] flex-col sm:max-w-2xl"
        data-testid="artifact-source-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('artifact.sourceDialog.title')}</DialogTitle>
          <DialogDescription>{t('artifact.sourceDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden">
          <button
            type="button"
            className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
              mode === 'all' ? 'border-primary bg-primary/5' : 'border-border hover:bg-hover'
            }`}
            onClick={() => setMode('all')}
            data-testid="artifact-source-all"
          >
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
              <Database className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t('artifact.sourceDialog.all')}</span>
                {mode === 'all' && <Check className="h-5 w-5 text-primary" />}
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                {t('artifact.sourceDialog.allHint', {
                  count: availableDocumentCount ?? 0,
                })}
              </p>
            </div>
          </button>

          <div
            className={`flex min-h-0 flex-col rounded-xl border ${
              mode === 'selected' ? 'border-primary' : 'border-border'
            }`}
          >
            <button
              type="button"
              className="flex items-start gap-3 p-4 text-left"
              onClick={() => setMode('selected')}
              data-testid="artifact-source-selected"
            >
              <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{t('artifact.sourceDialog.selected')}</span>
                  {mode === 'selected' && <Check className="h-5 w-5 text-primary" />}
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('artifact.sourceDialog.selectedHint', { count: draftIds.size })}
                </p>
              </div>
            </button>

            {mode === 'selected' && (
              <div className="flex min-h-0 flex-1 flex-col border-t border-border p-3">
                {draftIds.size > 0 && (
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-text-secondary">
                    <span>{t('artifact.sourceDialog.selectedHint', { count: draftIds.size })}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setDraftIds(new Set())}
                      data-testid="artifact-source-clear"
                    >
                      {t('artifact.sourceDialog.clear')}
                    </Button>
                  </div>
                )}
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <Input
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder={t('artifact.sourceDialog.search')}
                    className="pl-9"
                    data-testid="artifact-source-search"
                  />
                </div>

                <div className="min-h-0 flex-1 space-y-1 overflow-auto">
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
                      const isSelected = draftIds.has(document.id)
                      const canToggle = eligible || isSelected
                      return (
                        <label
                          key={document.id}
                          className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                            canToggle
                              ? 'cursor-pointer hover:bg-hover'
                              : 'cursor-not-allowed opacity-60'
                          }`}
                        >
                          <Checkbox
                            checked={isSelected}
                            disabled={!canToggle}
                            onCheckedChange={checked =>
                              toggleDocument(document.id, checked === true)
                            }
                            data-testid={`artifact-source-document-${document.id}`}
                          />
                          <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                          <span className="min-w-0 flex-1 truncate text-sm">{document.name}</span>
                          {!eligible && (
                            <span className="text-xs text-text-muted">
                              {t(`artifact.sourceDialog.status.${getSourceStatusKey(document)}`)}
                            </span>
                          )}
                        </label>
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
                    onPageSizeChange={changePageSize}
                    disabled={loading}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('artifact.cancel')}
          </Button>
          <Button
            onClick={handleApply}
            disabled={mode === 'selected' && draftIds.size === 0}
            data-testid="artifact-source-apply"
          >
            {t('artifact.sourceDialog.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
