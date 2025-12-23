// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  Upload,
  FileText,
  Search,
  ChevronUp,
  ChevronDown,
  FolderOpen,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Target,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { DocumentItem } from './DocumentItem';
import { DocumentUpload } from './DocumentUpload';
import { DeleteDocumentDialog } from './DeleteDocumentDialog';
import { EditDocumentDialog } from './EditDocumentDialog';
import { RetrievalTestDialog } from './RetrievalTestDialog';
import { useDocuments } from '../hooks/useDocuments';
import { useAttachment } from '@/hooks/useAttachment';
import type { KnowledgeBase, KnowledgeDocument } from '@/types/knowledge';
import { useTranslation } from '@/hooks/useTranslation';

interface DocumentListProps {
  knowledgeBase: KnowledgeBase;
  onBack?: () => void;
  canManage?: boolean;
}

type SortField = 'name' | 'size' | 'date';
type SortOrder = 'asc' | 'desc';
type StatusFilter = 'all' | 'enabled' | 'disabled';

export function DocumentList({ knowledgeBase, onBack, canManage = true }: DocumentListProps) {
  const { t } = useTranslation();
  const {
    documents,
    loading,
    error,
    create,
    toggleStatus,
    remove,
    refresh,
    batchDelete,
    batchEnable,
    batchDisable,
  } = useDocuments({ knowledgeBaseId: knowledgeBase.id });

  // Only show error on page for initial load failures (when documents list is empty)
  // Operation errors are shown via toast notifications
  const showLoadError = error && documents.length === 0;

  const [showUpload, setShowUpload] = useState(false);
  const [showRetrievalTest, setShowRetrievalTest] = useState(false);
  const [editingDoc, setEditingDoc] = useState<KnowledgeDocument | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<KnowledgeDocument | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);

  // Inline dropzone file upload
  const inlineFileInputRef = useRef<HTMLInputElement>(null);
  const {
    state: inlineUploadState,
    handleFileSelect: handleInlineFileSelect,
    reset: resetInlineUpload,
  } = useAttachment();

  const filteredAndSortedDocuments = useMemo(() => {
    let result = [...documents];

    // Filter by status
    if (statusFilter !== 'all') {
      result = result.filter(doc => doc.status === statusFilter);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(doc => doc.name.toLowerCase().includes(query));
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size':
          comparison = a.file_size - b.file_size;
          break;
        case 'date':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [documents, searchQuery, statusFilter, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc' ? (
      <ChevronUp className="w-3 h-3 inline ml-1" />
    ) : (
      <ChevronDown className="w-3 h-3 inline ml-1" />
    );
  };

  const handleUploadComplete = async (
    attachmentId: number,
    file: File,
    splitterConfig?: {
      type?: 'sentence';
      separator?: string;
      chunk_size?: number;
      chunk_overlap?: number;
    }
  ) => {
    const extension = file.name.split('.').pop() || '';
    try {
      await create({
        attachment_id: attachmentId,
        name: file.name,
        file_extension: extension,
        file_size: file.size,
        splitter_config: splitterConfig,
      });
      setShowUpload(false);
    } catch {
      // Error handled by hook
    }
  };

  const handleDelete = async () => {
    if (!deletingDoc) return;
    try {
      await remove(deletingDoc.id);
      setDeletingDoc(null);
    } catch {
      // Error handled by hook
    }
  };
  // Handle inline dropzone - directly trigger file picker or handle dropped files
  const handleDropzoneClick = useCallback(() => {
    inlineFileInputRef.current?.click();
  }, []);

  const handleInlineFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleInlineFileSelect(file);
      }
      // Reset input value to allow selecting the same file again
      if (inlineFileInputRef.current) {
        inlineFileInputRef.current.value = '';
      }
    },
    [handleInlineFileSelect]
  );

  const handleInlineDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleInlineFileSelect(file);
      }
    },
    [handleInlineFileSelect]
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  // Auto-create document when inline upload completes
  useEffect(() => {
    const autoCreateDocument = async () => {
      if (
        inlineUploadState.attachment?.id &&
        inlineUploadState.file &&
        !inlineUploadState.isUploading &&
        !inlineUploadState.error
      ) {
        const file = inlineUploadState.file;
        const extension = file.name.split('.').pop() || '';
        try {
          await create({
            attachment_id: inlineUploadState.attachment.id,
            name: file.name,
            file_extension: extension,
            file_size: file.size,
          });
          resetInlineUpload();
        } catch {
          // Error handled by hook
        }
      }
    };
    autoCreateDocument();
  }, [
    inlineUploadState.attachment,
    inlineUploadState.file,
    inlineUploadState.isUploading,
    inlineUploadState.error,
    create,
    resetInlineUpload,
  ]);

  // Batch selection handlers
  const handleSelectDoc = (doc: KnowledgeDocument, selected: boolean) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (selected) {
        newSet.add(doc.id);
      } else {
        newSet.delete(doc.id);
      }
      return newSet;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredAndSortedDocuments.map(doc => doc.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const isAllSelected =
    filteredAndSortedDocuments.length > 0 &&
    filteredAndSortedDocuments.every(doc => selectedIds.has(doc.id));

  const isPartialSelected = selectedIds.size > 0 && !isAllSelected;

  // Batch operations using batch API
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      await batchDelete(Array.from(selectedIds));
      setSelectedIds(new Set());
    } catch {
      // Error handled by hook
    } finally {
      setBatchLoading(false);
    }
  };

  const handleBatchEnable = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      await batchEnable(Array.from(selectedIds));
      setSelectedIds(new Set());
    } catch {
      // Error handled by hook
    } finally {
      setBatchLoading(false);
    }
  };

  const handleBatchDisable = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      await batchDisable(Array.from(selectedIds));
      setSelectedIds(new Set());
    } catch {
      // Error handled by hook
    } finally {
      setBatchLoading(false);
    }
  };

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
          <h2 className="text-base font-medium text-text-primary truncate">{knowledgeBase.name}</h2>
          {knowledgeBase.description && (
            <p className="text-xs text-text-muted truncate">{knowledgeBase.description}</p>
          )}
        </div>
      </div>

      {/* Filter and Search bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="h-9 px-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">{t('knowledge.document.document.filter.all')}</option>
          <option value="enabled">{t('knowledge.document.document.filter.enabled')}</option>
          <option value="disabled">{t('knowledge.document.document.filter.disabled')}</option>
        </select>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            className="w-full h-9 pl-9 pr-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={t('knowledge.document.document.search')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        {/* Spacer to push buttons to the right */}
        <div className="flex-1" />

        {/* Retrieval test button */}
        <Button variant="outline" size="sm" onClick={() => setShowRetrievalTest(true)}>
          <Target className="w-4 h-4 mr-1" />
          {t('knowledge.document.retrievalTest.button')}
        </Button>

        {/* Upload button - right aligned */}
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setShowUpload(true)}>
            <Upload className="w-4 h-4 mr-1" />
            {t('knowledge.document.document.upload')}
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
            {t('actions.retry')}
          </Button>
        </div>
      ) : filteredAndSortedDocuments.length > 0 ? (
        <>
          {/* Batch action bar - shown when items are selected */}
          {canManage && selectedIds.size > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
              <span className="text-sm text-text-primary">
                {t('knowledge.document.document.batch.selected', { count: selectedIds.size })}
              </span>
              <div className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchEnable}
                disabled={batchLoading}
              >
                <ToggleRight className="w-4 h-4 mr-1" />
                {t('knowledge.document.document.batch.enable')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchDisable}
                disabled={batchLoading}
              >
                <ToggleLeft className="w-4 h-4 mr-1" />
                {t('knowledge.document.document.batch.disable')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBatchDelete}
                disabled={batchLoading}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                {t('knowledge.document.document.batch.delete')}
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
                {t('knowledge.document.document.columns.name')}
                <SortIcon field="name" />
              </div>
              {/* Spacer to match DocumentItem middle area */}
              <div className="w-48 flex-shrink-0" />
              <div className="w-20 flex-shrink-0 text-center">
                {t('knowledge.document.document.columns.type')}
              </div>
              <div
                className="w-20 flex-shrink-0 text-center cursor-pointer hover:text-text-primary select-none"
                onClick={() => handleSort('size')}
              >
                {t('knowledge.document.document.columns.size')}
                <SortIcon field="size" />
              </div>
              <div
                className="w-40 flex-shrink-0 text-center cursor-pointer hover:text-text-primary select-none"
                onClick={() => handleSort('date')}
              >
                {t('knowledge.document.document.columns.date')}
                <SortIcon field="date" />
              </div>
              <div className="w-16 flex-shrink-0 text-center">
                {t('knowledge.document.document.columns.status')}
              </div>
              {canManage && (
                <div className="w-20 flex-shrink-0 text-center">
                  {t('knowledge.document.document.columns.actions')}
                </div>
              )}
            </div>
            {/* Document rows */}
            {filteredAndSortedDocuments.map((doc, index) => (
              <DocumentItem
                key={doc.id}
                document={doc}
                onToggleStatus={toggleStatus}
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
      ) : searchQuery || statusFilter !== 'all' ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('knowledge.document.document.noResults')}</p>
        </div>
      ) : canManage ? (
        <div className="flex justify-center py-8">
          <div
            className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors max-w-md w-full"
            onClick={!inlineUploadState.isUploading ? handleDropzoneClick : undefined}
            onDrop={handleInlineDrop}
            onDragOver={handleDragOver}
          >
            {inlineUploadState.isUploading ? (
              <>
                <Spinner className="w-10 h-10 mx-auto mb-4" />
                <p className="text-text-primary font-medium mb-2">
                  {t('knowledge.document.document.uploading')}
                </p>
                <Progress value={inlineUploadState.uploadProgress} className="max-w-xs mx-auto" />
                <p className="text-sm text-text-muted mt-2">{inlineUploadState.uploadProgress}%</p>
              </>
            ) : (
              <>
                <Upload className="w-10 h-10 mx-auto mb-4 text-text-muted" />
                <p className="text-text-primary font-medium">
                  {t('knowledge.document.document.dropzone')}
                </p>
                <p className="text-sm text-text-muted mt-2">
                  {t('knowledge.document.document.supportedTypes')}
                </p>
              </>
            )}
            <input
              ref={inlineFileInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.gif,.bmp,.webp"
              onChange={handleInlineFileChange}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('knowledge.document.document.empty')}</p>
        </div>
      )}

      {/* Dialogs */}
      <DocumentUpload
        open={showUpload}
        onOpenChange={setShowUpload}
        onUploadComplete={handleUploadComplete}
      />

      <EditDocumentDialog
        open={!!editingDoc}
        onOpenChange={open => !open && setEditingDoc(null)}
        document={editingDoc}
        onSuccess={() => {
          setEditingDoc(null);
          refresh();
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
  );
}
