// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo } from 'react'
import {
  ArrowLeft,
  Upload,
  FileText,
  Search,
  ChevronUp,
  ChevronDown,
  FolderOpen,
  Trash2,
  Target,
  FileUp,
  RefreshCw,
  Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DocumentDetailDialog } from './DocumentDetailDialog'
import { DocumentItem } from './DocumentItem'
import { DocumentUpload, type TableDocument } from './DocumentUpload'
import { DeleteDocumentDialog } from './DeleteDocumentDialog'
import { EditDocumentDialog } from './EditDocumentDialog'
import { RetrievalTestDialog } from './RetrievalTestDialog'
import { useDocuments } from '../hooks/useDocuments'
import type { KnowledgeBase, KnowledgeDocument, SplitterConfig } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface DocumentListProps {
  knowledgeBase: KnowledgeBase
  onBack?: () => void
  canManage?: boolean
}

type SortField = 'name' | 'size' | 'date'
type SortOrder = 'asc' | 'desc'

export function DocumentList({ knowledgeBase, onBack, canManage = true }: DocumentListProps) {
  const { t } = useTranslation('knowledge')
  const { documents, loading, error, create, remove, refresh, batchDelete } = useDocuments({
    knowledgeBaseId: knowledgeBase.id,
  })

  // Only show error on page for initial load failures (when documents list is empty)
  // Operation errors are shown via toast notifications
  const showLoadError = error && documents.length === 0

  const [showUpload, setShowUpload] = useState(false)
  const [showRetrievalTest, setShowRetrievalTest] = useState(false)
  const [viewingDoc, setViewingDoc] = useState<KnowledgeDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<KnowledgeDocument | null>(null)
  const [deletingDoc, setDeletingDoc] = useState<KnowledgeDocument | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchLoading, setBatchLoading] = useState(false)

  const filteredAndSortedDocuments = useMemo(() => {
    let result = [...documents]

    // Filter by search query (name-based frontend search)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(doc => doc.name.toLowerCase().includes(query))
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name)
          break
        case 'size':
          comparison = a.file_size - b.file_size
          break
        case 'date':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
      }
      return sortOrder === 'asc' ? comparison : -comparison
    })

    return result
  }, [documents, searchQuery, sortField, sortOrder])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortOrder('desc')
    }
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null
    return sortOrder === 'asc' ? (
      <ChevronUp className="w-3 h-3 inline ml-1" />
    ) : (
      <ChevronDown className="w-3 h-3 inline ml-1" />
    )
  }

  const handleUploadComplete = async (
    attachments: { attachment: { id: number; filename: string }; file: File }[],
    splitterConfig?: Partial<SplitterConfig>
  ) => {
    // Create documents sequentially to ensure all are created
    for (const { attachment, file } of attachments) {
      // Use attachment.filename (which may have been renamed) instead of file.name
      const documentName = attachment.filename || file.name
      const extension = documentName.split('.').pop() || ''
      try {
        await create({
          attachment_id: attachment.id,
          name: documentName,
          file_extension: extension,
          file_size: file.size,
          splitter_config: splitterConfig,
          source_type: 'file',
        })
      } catch {
        // Continue with next file even if one fails
      }
    }
    setShowUpload(false)
  }

  const handleTableAdd = async (data: TableDocument) => {
    await create({
      name: data.name,
      file_extension: 'table',
      file_size: 0,
      source_type: 'table',
      source_config: data.source_config,
    })
    setShowUpload(false)
  }

  const handleDelete = async () => {
    if (!deletingDoc) return
    try {
      await remove(deletingDoc.id)
      setDeletingDoc(null)
    } catch {
      // Error handled by hook
    }
  }
  // Batch selection handlers
  const handleSelectDoc = (doc: KnowledgeDocument, selected: boolean) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev)
      if (selected) {
        newSet.add(doc.id)
      } else {
        newSet.delete(doc.id)
      }
      return newSet
    })
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredAndSortedDocuments.map(doc => doc.id)))
    } else {
      setSelectedIds(new Set())
    }
  }

  const isAllSelected =
    filteredAndSortedDocuments.length > 0 &&
    filteredAndSortedDocuments.every(doc => selectedIds.has(doc.id))

  const isPartialSelected = selectedIds.size > 0 && !isAllSelected

  // Batch operations using batch API
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    setBatchLoading(true)
    try {
      await batchDelete(Array.from(selectedIds))
      setSelectedIds(new Set())
    } catch {
      // Error handled by hook
    } finally {
      setBatchLoading(false)
    }
  }

  const longSummary = knowledgeBase.summary?.long_summary

  return (
    <div className="space-y-4">
      {/* Header - Wegent style */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <FolderOpen className="w-5 h-5 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-base font-medium text-text-primary truncate">
              {knowledgeBase.name}
            </h2>
            {/* Summary tooltip - next to title */}
            {longSummary && (
              <TooltipProvider>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <button className="flex-shrink-0 p-0.5 rounded text-text-muted hover:text-primary hover:bg-surface transition-colors">
                      <Info className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start" className="max-w-md">
                    <p className="text-sm leading-relaxed">{longSummary}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          {knowledgeBase.description && (
            <p className="text-xs text-text-muted truncate">{knowledgeBase.description}</p>
          )}
        </div>
      </div>

      {/* Search bar and action buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            className="w-full h-9 pl-9 pr-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={t('document.document.search')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        {/* Spacer to push buttons to the right */}
        <div className="flex-1" />

        {/* Refresh button */}
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>

        {/* Retrieval test button */}
        <Button variant="outline" size="sm" onClick={() => setShowRetrievalTest(true)}>
          <Target className="w-4 h-4 mr-1" />
          {t('document.retrievalTest.button')}
        </Button>

        {/* Upload button */}
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setShowUpload(true)}>
            <Upload className="w-4 h-4 mr-1" />
            {t('document.document.upload')}
          </Button>
        )}
      </div>

      {/* Document List */}
      {loading && documents.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : showLoadError ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <p>{error}</p>
          <Button variant="outline" className="mt-4" onClick={refresh}>
            {t('common:actions.retry')}
          </Button>
        </div>
      ) : filteredAndSortedDocuments.length > 0 ? (
        <>
          {/* Batch action bar - shown when items are selected */}
          {canManage && selectedIds.size > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
              <span className="text-sm text-text-primary">
                {t('document.document.batch.selected', { count: selectedIds.size })}
              </span>
              <div className="flex-1" />
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBatchDelete}
                disabled={batchLoading}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                {t('document.document.batch.delete')}
              </Button>
            </div>
          )}
          <div className="border border-border rounded-lg overflow-hidden">
            {/* Table header */}
            <div className="flex items-center gap-4 px-4 py-2.5 bg-surface text-xs text-text-muted font-medium">
              {/* Checkbox for select all */}
              {canManage && (
                <div className="flex-shrink-0">
                  <Checkbox
                    checked={isAllSelected}
                    onCheckedChange={handleSelectAll}
                    className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    {...(isPartialSelected ? { 'data-state': 'indeterminate' } : {})}
                  />
                </div>
              )}
              {/* Icon placeholder */}
              <div className="w-8 flex-shrink-0" />
              <div
                className="flex-1 min-w-[120px] cursor-pointer hover:text-text-primary select-none"
                onClick={() => handleSort('name')}
              >
                {t('document.document.columns.name')}
                <SortIcon field="name" />
              </div>
              {/* Spacer to match DocumentItem middle area */}
              <div className="w-48 flex-shrink-0" />
              <div className="w-20 flex-shrink-0 text-center">
                {t('document.document.columns.type')}
              </div>
              <div
                className="w-20 flex-shrink-0 text-center cursor-pointer hover:text-text-primary select-none"
                onClick={() => handleSort('size')}
              >
                {t('document.document.columns.size')}
                <SortIcon field="size" />
              </div>
              <div
                className="w-40 flex-shrink-0 text-center cursor-pointer hover:text-text-primary select-none"
                onClick={() => handleSort('date')}
              >
                {t('document.document.columns.date')}
                <SortIcon field="date" />
              </div>
              <div className="w-24 flex-shrink-0 text-center">
                {t('document.document.columns.indexStatus')}
              </div>
              {canManage && (
                <div className="w-16 flex-shrink-0 text-center">
                  {t('document.document.columns.actions')}
                </div>
              )}
            </div>
            {/* Document rows */}
            {filteredAndSortedDocuments.map((doc, index) => (
              <DocumentItem
                key={doc.id}
                document={doc}
                onViewDetail={setViewingDoc}
                onEdit={setEditingDoc}
                onDelete={setDeletingDoc}
                canManage={canManage}
                showBorder={index < filteredAndSortedDocuments.length - 1}
                selected={selectedIds.has(doc.id)}
                onSelect={handleSelectDoc}
              />
            ))}
          </div>
        </>
      ) : searchQuery ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('document.document.noResults')}</p>
        </div>
      ) : canManage ? (
        <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
          <FileUp className="w-16 h-16 mb-4 text-text-muted opacity-60" />
          <p className="text-base text-text-primary mb-2">{t('document.document.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('document.document.empty')}</p>
        </div>
      )}

      {/* Dialogs */}
      <DocumentDetailDialog
        open={!!viewingDoc}
        onOpenChange={open => !open && setViewingDoc(null)}
        document={viewingDoc}
        knowledgeBaseId={knowledgeBase.id}
      />

      <DocumentUpload
        open={showUpload}
        onOpenChange={setShowUpload}
        onUploadComplete={handleUploadComplete}
        onTableAdd={handleTableAdd}
      />

      <EditDocumentDialog
        open={!!editingDoc}
        onOpenChange={open => !open && setEditingDoc(null)}
        document={editingDoc}
        onSuccess={() => {
          setEditingDoc(null)
          refresh()
        }}
      />

      <DeleteDocumentDialog
        open={!!deletingDoc}
        onOpenChange={open => !open && setDeletingDoc(null)}
        document={deletingDoc}
        onConfirm={handleDelete}
        loading={loading}
      />

      <RetrievalTestDialog
        open={showRetrievalTest}
        onOpenChange={setShowRetrievalTest}
        knowledgeBase={knowledgeBase}
      />
    </div>
  )
}
