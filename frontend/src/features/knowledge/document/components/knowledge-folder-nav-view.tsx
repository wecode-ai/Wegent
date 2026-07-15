// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useMemo, useRef } from 'react'
import {
  flexRender,
  getCoreRowModel,
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CloudDownload,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  Pencil,
  RotateCcw,
  Table2,
  Trash2,
} from 'lucide-react'

import { downloadAttachment } from '@/apis/attachments'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'
import type { SortField, SortOrder } from './FolderTree'

type FolderNavRow =
  | { kind: 'folder'; folder: KnowledgeFolder }
  | { kind: 'document'; document: KnowledgeDocument }

interface KnowledgeFolderNavViewProps {
  subfolders: KnowledgeFolder[]
  documents: KnowledgeDocument[]
  onNavigateFolder: (folderId: number) => void
  showSelectionColumn: boolean
  showActionsColumn: boolean
  sortField: SortField
  sortOrder: SortOrder
  onSortChange: (field: SortField, order: SortOrder) => void
  isAllSelected: boolean
  isPartialSelected: boolean
  onSelectAll: (checked: boolean) => void
  selectAllLabel: string
  onCreateFolder?: (parentId: number) => void
  onRenameFolder?: (folderId: number, currentName: string) => void
  onDeleteFolder?: (folderId: number, folderName: string) => void
  canManageFolders?: boolean
  selectedDocumentIds: Set<number>
  onViewDetail?: (doc: KnowledgeDocument) => void
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onReindex?: (doc: KnowledgeDocument) => void
  onMove?: (doc: KnowledgeDocument) => void
  refreshingDocId?: number | null
  reindexingDocId?: number | null
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  includedInFolderScope?: (doc: KnowledgeDocument) => boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(dateString?: string) {
  if (!dateString) return '-'
  const date = new Date(dateString)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
}

function getDocumentDisplayName(document: KnowledgeDocument) {
  return document.source_type === 'web' && document.name.endsWith('.md')
    ? document.name.slice(0, -3)
    : document.name
}

function isSortableColumnId(columnId: string): columnId is SortField {
  return ['name', 'size', 'createdAt', 'updatedAt'].includes(columnId)
}

function canOpenExternalUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
  } catch {
    return false
  }
}

export function KnowledgeFolderNavView({
  subfolders,
  documents,
  onNavigateFolder,
  showSelectionColumn,
  showActionsColumn,
  sortField,
  sortOrder,
  onSortChange,
  isAllSelected,
  isPartialSelected,
  onSelectAll,
  selectAllLabel,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  canManageFolders = false,
  selectedDocumentIds,
  onViewDetail,
  onEdit,
  onDelete,
  onRefresh,
  onReindex,
  onMove,
  refreshingDocId,
  reindexingDocId,
  canManage,
  canSelect,
  includedInFolderScope,
  onSelect,
  ragConfigured = true,
}: KnowledgeFolderNavViewProps) {
  const { t } = useTranslation('knowledge')
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})

  const rows = useMemo<FolderNavRow[]>(() => {
    const folderRows: FolderNavRow[] = subfolders.map(f => ({ kind: 'folder', folder: f }))
    const docRows: FolderNavRow[] = documents.map(d => ({ kind: 'document', document: d }))
    return [...folderRows, ...docRows]
  }, [subfolders, documents])

  const handleDocumentDownload = useCallback(
    async (document: KnowledgeDocument) => {
      if (document.source_type !== 'file' || !document.attachment_id) return
      try {
        await downloadAttachment(document.attachment_id, document.name)
      } catch {
        toast({ title: t('document.document.downloadFailed'), variant: 'destructive' })
      }
    },
    [t]
  )

  const columns = useMemo<ColumnDef<FolderNavRow>[]>(
    () => [
      {
        id: 'selection',
        size: 20,
        minSize: 20,
        maxSize: 20,
        enableResizing: false,
        header: () =>
          showSelectionColumn ? (
            <Checkbox
              checked={isPartialSelected ? 'indeterminate' : isAllSelected}
              onCheckedChange={checked => onSelectAll(checked === true)}
              aria-label={selectAllLabel}
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
              data-testid="select-all-resources-checkbox"
            />
          ) : null,
        cell: ({ row }) => {
          if (!showSelectionColumn) return null
          const item = row.original
          // No checkbox for folder rows in nav view
          if (item.kind === 'folder') return null
          const document = item.document
          const includedByFolder = includedInFolderScope?.(document) ?? false
          const selectable = canSelect?.(document) ?? false
          if (!selectable && !includedByFolder) return null
          return (
            <Checkbox
              checked={selectedDocumentIds.has(document.id) || includedByFolder}
              disabled={includedByFolder}
              onCheckedChange={checked => onSelect?.(document, checked === true)}
              onClick={event => event.stopPropagation()}
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary disabled:opacity-60"
            />
          )
        },
      },
      {
        id: 'name',
        accessorFn: row => (row.kind === 'folder' ? row.folder.name : row.document.name),
        header: () => t('document.document.columns.name'),
        size: 280,
        minSize: 200,
        maxSize: 520,
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') {
            const folder = item.folder
            const totalCount = folder.total_document_count ?? folder.document_count
            return (
              <div className="flex items-center gap-2 overflow-hidden min-w-0">
                <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
                <TooltipProvider>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                        {folder.name}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="text-xs break-all">{folder.name}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className="flex-shrink-0 text-xs text-text-muted">
                  {t('document.folder.docCount', { count: totalCount })}
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-text-muted ml-auto" />
              </div>
            )
          }

          const document = item.document
          const isTable = document.source_type === 'table'
          const isWeb = document.source_type === 'web'
          const sourceUrl =
            (isTable || isWeb) &&
            document.source_config?.url &&
            typeof document.source_config.url === 'string'
              ? document.source_config.url
              : null
          const displayName = getDocumentDisplayName(document)
          return (
            <div className="flex items-center gap-2 overflow-hidden min-w-0">
              {isTable ? (
                <Table2 className="w-4 h-4 text-primary flex-shrink-0" />
              ) : isWeb ? (
                <Globe className="w-4 h-4 text-primary flex-shrink-0" />
              ) : (
                <FileText className="w-4 h-4 text-primary flex-shrink-0" />
              )}
              <TooltipProvider>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <span className="min-w-0 flex-1 text-sm font-medium text-text-primary truncate">
                      {displayName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs break-all">{displayName}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {sourceUrl && (
                <button
                  className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
                  onClick={event => {
                    event.stopPropagation()
                    if (canOpenExternalUrl(sourceUrl)) {
                      window.open(sourceUrl, '_blank', 'noopener,noreferrer')
                    }
                  }}
                  title={t('document.document.openLink')}
                  data-testid={`open-document-source-${document.id}`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )
        },
      },
      {
        id: 'quickAction',
        size: 28,
        minSize: 28,
        maxSize: 28,
        enableSorting: false,
        enableResizing: false,
        header: () => null,
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') {
            if (!canManageFolders || !onRenameFolder) return null
            const label = t('document.folder.rename')
            return (
              <button
                className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors"
                title={label}
                aria-label={label}
                onClick={event => {
                  event.stopPropagation()
                  onRenameFolder(item.folder.id, item.folder.name)
                }}
                data-testid={`rename-folder-${item.folder.id}`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )
          }
          const document = item.document
          if (!onEdit || !(canManage?.(document) ?? true)) return null
          const label = t('common:actions.edit')
          return (
            <button
              className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors"
              onClick={event => {
                event.stopPropagation()
                onEdit?.(document)
              }}
              title={label}
              aria-label={label}
              data-testid={`edit-document-${document.id}`}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )
        },
      },
      {
        id: 'type',
        size: 80,
        minSize: 72,
        maxSize: 120,
        header: () => t('document.document.columns.type'),
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') {
            return (
              <Badge
                variant="default"
                size="sm"
                className="bg-amber-500/10 text-amber-700 border-amber-500/20"
              >
                {t('document.folder.folderType')}
              </Badge>
            )
          }
          const document = item.document
          if (document.source_type === 'table') {
            return (
              <Badge
                variant="default"
                size="sm"
                className="bg-blue-500/10 text-blue-600 border-blue-500/20"
              >
                {t('document.document.type.table')}
              </Badge>
            )
          }
          if (document.source_type === 'web') {
            return (
              <Badge
                variant="default"
                size="sm"
                className="bg-green-500/10 text-green-600 border-green-500/20"
              >
                {t('document.document.type.web')}
              </Badge>
            )
          }
          return (
            <span className="text-xs text-text-muted uppercase">{document.file_extension}</span>
          )
        },
      },
      {
        id: 'size',
        size: 80,
        minSize: 72,
        maxSize: 120,
        header: () => t('document.document.columns.size'),
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') return <span className="text-xs text-text-muted">-</span>
          const document = item.document
          return (
            <span className="text-xs text-text-muted">
              {document.source_type === 'table' || document.source_type === 'web'
                ? '-'
                : formatFileSize(document.file_size)}
            </span>
          )
        },
      },
      {
        id: 'createdBy',
        size: 96,
        minSize: 80,
        maxSize: 160,
        header: () => t('document.document.columns.createdBy'),
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') return <span className="text-xs text-text-muted">-</span>
          return (
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="block text-xs text-text-muted truncate">
                    {item.document.created_by || '-'}
                  </span>
                </TooltipTrigger>
                {item.document.created_by && (
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{item.document.created_by}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )
        },
      },
      {
        id: 'createdAt',
        size: 160,
        minSize: 132,
        maxSize: 220,
        header: () => t('document.document.columns.date'),
        cell: ({ row }) => {
          const item = row.original
          const value = item.kind === 'folder' ? item.folder.created_at : item.document.created_at
          return <span className="text-xs text-text-muted">{formatDateTime(value)}</span>
        },
      },
      {
        id: 'updatedAt',
        size: 160,
        minSize: 132,
        maxSize: 220,
        header: () => t('document.document.columns.updatedAt'),
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') {
            return (
              <span className="text-xs text-text-muted">
                {formatDateTime(item.folder.updated_at)}
              </span>
            )
          }
          const document = item.document
          return (
            <span className="text-xs text-text-muted">
              {document.updated_at === document.created_at
                ? '-'
                : formatDateTime(document.updated_at)}
            </span>
          )
        },
      },
      {
        id: 'indexStatus',
        size: 96,
        minSize: 88,
        maxSize: 140,
        enableSorting: false,
        header: () => t('document.document.columns.indexStatus'),
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') return <span className="text-xs text-text-muted">-</span>
          const document = item.document
          const isPendingConversion = document.index_status === 'pending_conversion'
          const isConverting = document.index_status === 'converting'
          const isIndexing =
            document.index_status === 'queued' ||
            document.index_status === 'indexing' ||
            isConverting ||
            isPendingConversion
          if (document.is_active) {
            return (
              <Badge variant="success" size="sm" className="whitespace-nowrap">
                {t('document.document.indexStatus.available')}
              </Badge>
            )
          }
          if (isIndexing || reindexingDocId === document.id) {
            return (
              <Badge
                variant="default"
                size="sm"
                className="whitespace-nowrap bg-blue-500/10 text-blue-600 border-blue-500/20"
              >
                {isPendingConversion
                  ? t('document.document.indexStatus.pendingConversion')
                  : isConverting
                    ? t('document.document.indexStatus.converting')
                    : t('document.document.indexStatus.indexing')}
              </Badge>
            )
          }
          return (
            <Badge variant="warning" size="sm" className="whitespace-nowrap">
              {document.index_status === 'not_indexed'
                ? t('document.document.indexStatus.notIndexed')
                : t('document.document.indexStatus.unavailable')}
            </Badge>
          )
        },
      },
      {
        id: 'actions',
        size: 80,
        minSize: 72,
        maxSize: 140,
        enableSorting: false,
        header: () => t('document.document.columns.actions'),
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === 'folder') {
            if (!canManageFolders) return null
            const folder = item.folder
            return (
              <div className="flex items-center justify-center gap-1">
                {onCreateFolder && (
                  <button
                    className="p-1 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                    title={t('document.folder.create')}
                    aria-label={t('document.folder.create')}
                    onClick={event => {
                      event.stopPropagation()
                      onCreateFolder(folder.id)
                    }}
                    data-testid={`create-subfolder-${folder.id}`}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                )}
                {onDeleteFolder && (
                  <button
                    className="p-1 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                    title={t('document.folder.delete')}
                    aria-label={t('document.folder.delete')}
                    onClick={event => {
                      event.stopPropagation()
                      onDeleteFolder(folder.id, folder.name)
                    }}
                    data-testid={`delete-folder-${folder.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )
          }

          const document = item.document
          if (!(canManage?.(document) ?? true)) return null
          const isWeb = document.source_type === 'web'
          const isTable = document.source_type === 'table'
          const isNotIndexed = document.index_status === 'not_indexed'
          const isIndexFailed = document.index_status === 'failed'
          const isPendingConversion = document.index_status === 'pending_conversion'
          const isConverting = document.index_status === 'converting'
          const showIndexingState =
            reindexingDocId === document.id ||
            document.index_status === 'queued' ||
            document.index_status === 'indexing' ||
            isConverting ||
            isPendingConversion
          const canReindex =
            ragConfigured &&
            !isTable &&
            !!onReindex &&
            (isIndexFailed || isNotIndexed) &&
            !showIndexingState
          const showDownload = document.source_type === 'file' && !!document.attachment_id
          const moveLabel = t('document.folder.moveDocument')
          const refreshLabel =
            refreshingDocId === document.id
              ? t('document.upload.web.refetching')
              : t('document.upload.web.refetch')
          const reindexLabel = t('document.document.reindex')
          const downloadLabel = t('document.document.download')
          const deleteLabel = t('common:actions.delete')

          return (
            <div className="flex items-center justify-center gap-1">
              {onMove && (
                <button
                  className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                  onClick={event => {
                    event.stopPropagation()
                    onMove(document)
                  }}
                  title={moveLabel}
                  aria-label={moveLabel}
                  data-testid={`move-document-${document.id}`}
                >
                  <FolderInput className="w-3.5 h-3.5" />
                </button>
              )}
              {isWeb && onRefresh && (
                <button
                  className={`p-1.5 rounded-md transition-colors ${
                    refreshingDocId === document.id
                      ? 'text-primary cursor-not-allowed'
                      : 'text-text-muted hover:text-primary hover:bg-primary/10'
                  }`}
                  onClick={event => {
                    event.stopPropagation()
                    onRefresh(document)
                  }}
                  disabled={refreshingDocId === document.id}
                  title={refreshLabel}
                  aria-label={refreshLabel}
                  data-testid={`refresh-document-${document.id}`}
                >
                  <CloudDownload
                    className={`w-4 h-4 ${refreshingDocId === document.id ? 'animate-pulse' : ''}`}
                  />
                </button>
              )}
              {canReindex && (
                <button
                  className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                  onClick={event => {
                    event.stopPropagation()
                    onReindex?.(document)
                  }}
                  title={reindexLabel}
                  aria-label={reindexLabel}
                  data-testid={`reindex-document-${document.id}`}
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              {showDownload && (
                <button
                  className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                  onClick={event => {
                    event.stopPropagation()
                    handleDocumentDownload(document)
                  }}
                  title={downloadLabel}
                  aria-label={downloadLabel}
                  data-testid={`download-document-${document.id}`}
                >
                  <Download className="w-4 h-4" />
                </button>
              )}
              {onDelete && (
                <button
                  className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                  onClick={event => {
                    event.stopPropagation()
                    onDelete(document)
                  }}
                  title={deleteLabel}
                  aria-label={deleteLabel}
                  data-testid={`delete-document-${document.id}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )
        },
      },
    ],
    [
      canManage,
      canManageFolders,
      canSelect,
      handleDocumentDownload,
      includedInFolderScope,
      isAllSelected,
      isPartialSelected,
      onCreateFolder,
      onDelete,
      onDeleteFolder,
      onEdit,
      onMove,
      onRefresh,
      onReindex,
      onRenameFolder,
      onSelect,
      onSelectAll,
      ragConfigured,
      refreshingDocId,
      reindexingDocId,
      selectAllLabel,
      selectedDocumentIds,
      showSelectionColumn,
      t,
    ]
  )

  const sorting = useMemo<SortingState>(
    () => [{ id: sortField, desc: sortOrder === 'desc' }],
    [sortField, sortOrder]
  )
  const columnVisibility = useMemo(
    () => ({
      selection: showSelectionColumn,
      actions: showActionsColumn,
    }),
    [showActionsColumn, showSelectionColumn]
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnSizing, columnVisibility },
    manualSorting: true,
    columnResizeMode: 'onChange',
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getRowId: row =>
      row.kind === 'folder' ? `folder:${row.folder.id}` : `document:${row.document.id}`,
  })

  const tableRows = table.getRowModel().rows
  const visibleColumns = table.getVisibleLeafColumns()
  const gridTemplateColumns = visibleColumns.map(column => `${column.getSize()}px`).join(' ')
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 48,
    overscan: 8,
    initialRect: { width: 880, height: 720 },
  })
  const virtualItems = rowVirtualizer.getVirtualItems()
  const renderedVirtualItems =
    virtualItems.length > 0
      ? virtualItems
      : tableRows.slice(0, Math.min(tableRows.length, 30)).map((_, index) => ({
          index,
          start: index * 48,
        }))
  const totalSize = Math.max(rowVirtualizer.getTotalSize(), tableRows.length * 48)

  const handleHeaderSort = useCallback(
    (columnId: string) => {
      if (!isSortableColumnId(columnId)) return
      const nextOrder: SortOrder = sortField === columnId && sortOrder === 'desc' ? 'asc' : 'desc'
      onSortChange(columnId, nextOrder)
    },
    [onSortChange, sortField, sortOrder]
  )

  const renderHeaderCell = useCallback(
    (header: ReturnType<(typeof table)['getHeaderGroups']>[number]['headers'][number]) => {
      const sortable = isSortableColumnId(header.column.id)
      const sorted = header.column.getIsSorted()
      return (
        <div
          key={header.id}
          className={`relative flex items-center min-w-0 ${
            header.column.id === 'name'
              ? 'justify-start gap-2'
              : header.column.id === 'selection'
                ? 'justify-start'
                : 'justify-center text-center'
          }`}
        >
          {sortable ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 min-w-0 cursor-pointer hover:text-text-primary select-none"
              onClick={() => handleHeaderSort(header.column.id)}
              data-testid={`sort-${header.column.id}-header`}
            >
              <span className="truncate">
                {flexRender(header.column.columnDef.header, header.getContext())}
              </span>
              {sorted === 'asc' ? (
                <ChevronUp className="w-3 h-3 flex-shrink-0" />
              ) : sorted === 'desc' ? (
                <ChevronDown className="w-3 h-3 flex-shrink-0" />
              ) : null}
            </button>
          ) : (
            flexRender(header.column.columnDef.header, header.getContext())
          )}
          {header.column.getCanResize() && (
            <div
              className="absolute top-0 right-0 bottom-0 w-3 cursor-col-resize z-10 group/resize flex items-center justify-center"
              onMouseDown={header.getResizeHandler()}
              onTouchStart={header.getResizeHandler()}
              onClick={event => event.stopPropagation()}
            >
              <div className="w-0.5 h-3/4 rounded-full bg-border group-hover/resize:bg-primary/50 transition-colors" />
            </div>
          )}
        </div>
      )
    },
    [handleHeaderSort]
  )

  const renderRow = useCallback(
    (row: (typeof tableRows)[number]) => {
      const item = row.original
      const isFolder = item.kind === 'folder'
      const canClick = isFolder ? true : Boolean(onViewDetail)
      return (
        <div
          className={`grid items-center gap-4 px-4 py-3 transition-colors border-b border-border min-w-[880px] ${
            isFolder
              ? `bg-surface/50 hover:bg-surface cursor-pointer`
              : `bg-base hover:bg-surface group ${onViewDetail ? 'cursor-pointer' : ''}`
          }`}
          style={{ gridTemplateColumns }}
          onClick={() => {
            if (isFolder) {
              onNavigateFolder(item.folder.id)
            } else if (canClick) {
              onViewDetail?.(item.document)
            }
          }}
          role="button"
          tabIndex={0}
          onKeyDown={event => {
            if (event.currentTarget !== event.target) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (isFolder) {
                onNavigateFolder(item.folder.id)
              } else if (canClick) {
                onViewDetail?.(item.document)
              }
            }
          }}
        >
          {row.getVisibleCells().map(cell => (
            <div
              key={cell.id}
              className={`min-w-0 ${
                cell.column.id === 'name' ? '' : cell.column.id === 'selection' ? '' : 'text-center'
              }`}
              onClick={event => {
                if (cell.column.id === 'selection') event.stopPropagation()
              }}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          ))}
        </div>
      )
    },
    [gridTemplateColumns, onNavigateFolder, onViewDetail]
  )

  return (
    <div className="bg-base min-w-[880px] w-fit">
      {table.getHeaderGroups().map(headerGroup => (
        <div
          key={headerGroup.id}
          className="grid items-center gap-4 px-4 py-2.5 bg-surface text-xs text-text-muted font-medium border-b border-border min-w-[880px]"
          style={{ gridTemplateColumns }}
        >
          {headerGroup.headers.map(renderHeaderCell)}
        </div>
      ))}
      <div
        ref={scrollParentRef}
        className="max-h-[70vh] overflow-y-auto overflow-x-hidden"
        data-testid="knowledge-folder-nav-virtual-scroll"
      >
        <div className="relative" style={{ height: `${totalSize}px` }}>
          {renderedVirtualItems.map(virtualRow => {
            const tableRow = tableRows[virtualRow.index]
            if (!tableRow) return null
            return (
              <div
                key={tableRow.id}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(tableRow)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
