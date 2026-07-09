// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
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
  FolderOpen,
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
import type {
  KnowledgeResourceNode,
  KnowledgeResourceRow,
  KnowledgeResourceTreeIndex,
} from '../utils/resource-tree'
import {
  flattenKnowledgeResourceRows,
  getDefaultExpandedFolderKeys,
  getFolderPathKeys,
  getResultDocumentFolderKeys,
} from '../utils/resource-tree'

type SortableColumnId = SortField

interface KnowledgeDocumentTreeGridProps {
  nodes: KnowledgeResourceNode[]
  treeIndex: KnowledgeResourceTreeIndex
  folders: KnowledgeFolder[]
  documents: KnowledgeDocument[]
  showSelectionColumn: boolean
  showActionsColumn: boolean
  sortField: SortField
  sortOrder: SortOrder
  onSortChange: (field: SortField, order: SortOrder) => void
  isAllSelected: boolean
  isPartialSelected: boolean
  onSelectAll: (checked: boolean) => void
  selectAllLabel: string
  activeFolderId?: number
  onActivateFolder?: (folderId: number) => void
  onCreateFolder?: (parentId: number) => void
  onRenameFolder?: (folderId: number, currentName: string) => void
  onDeleteFolder?: (folderId: number, folderName: string) => void
  canManageFolders?: boolean
  canSelectFolders?: boolean
  selectedFolderIds: Set<number>
  selectedDocumentIds: Set<number>
  onSelectFolder?: (folderId: number, selected: boolean) => void
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

function hasSelectedDescendantDocument(
  node: KnowledgeResourceNode,
  selectedDocumentIds: Set<number>
): boolean {
  if (node.kind === 'document') {
    return selectedDocumentIds.has(node.documentId)
  }
  return node.children.some(child => hasSelectedDescendantDocument(child, selectedDocumentIds))
}

function hasSelectedDescendantFolder(
  node: KnowledgeResourceNode,
  selectedFolderIds: Set<number>
): boolean {
  if (node.kind === 'document') return false
  return node.children.some(child => {
    if (child.kind === 'document') return false
    return (
      selectedFolderIds.has(child.folderId) || hasSelectedDescendantFolder(child, selectedFolderIds)
    )
  })
}

function getDocumentDisplayName(document: KnowledgeDocument) {
  return document.source_type === 'web' && document.name.endsWith('.md')
    ? document.name.slice(0, -3)
    : document.name
}

function isSortableColumnId(columnId: string): columnId is SortableColumnId {
  return ['name', 'size', 'createdAt', 'updatedAt'].includes(columnId)
}

export function KnowledgeDocumentTreeGrid({
  nodes,
  treeIndex,
  folders,
  documents,
  showSelectionColumn,
  showActionsColumn,
  sortField,
  sortOrder,
  onSortChange,
  isAllSelected,
  isPartialSelected,
  onSelectAll,
  selectAllLabel,
  activeFolderId,
  onActivateFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  canManageFolders = false,
  canSelectFolders = false,
  selectedFolderIds,
  selectedDocumentIds,
  onSelectFolder,
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
}: KnowledgeDocumentTreeGridProps) {
  const { t } = useTranslation('knowledge')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})

  const defaultExpandedKeys = useMemo(() => getDefaultExpandedFolderKeys(folders), [folders])
  const activeFolderKeys = useMemo(
    () => getFolderPathKeys(treeIndex, activeFolderId),
    [treeIndex, activeFolderId]
  )
  const resultDocumentFolderKeys = useMemo(
    () => getResultDocumentFolderKeys(treeIndex, documents),
    [treeIndex, documents]
  )

  useEffect(() => {
    setExpandedKeys(previous => {
      const next = new Set(previous)
      defaultExpandedKeys.forEach(key => next.add(key))
      return next
    })
  }, [defaultExpandedKeys])

  useEffect(() => {
    if (activeFolderKeys.size === 0) return
    setExpandedKeys(previous => {
      const next = new Set(previous)
      activeFolderKeys.forEach(key => next.add(key))
      return next
    })
  }, [activeFolderKeys])

  useEffect(() => {
    if (resultDocumentFolderKeys.size === 0) return
    setExpandedKeys(previous => {
      const next = new Set(previous)
      resultDocumentFolderKeys.forEach(key => next.add(key))
      return next
    })
  }, [resultDocumentFolderKeys])

  const rows = useMemo(
    () => flattenKnowledgeResourceRows(nodes, expandedKeys),
    [nodes, expandedKeys]
  )

  const toggleFolder = useCallback((key: string) => {
    setExpandedKeys(previous => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const handleDocumentDownload = useCallback(
    async (document: KnowledgeDocument) => {
      if (document.source_type !== 'file' || !document.attachment_id) return
      try {
        await downloadAttachment(document.attachment_id, document.name)
      } catch {
        toast({
          title: t('document.document.downloadFailed'),
          variant: 'destructive',
        })
      }
    },
    [t]
  )

  const columns = useMemo<ColumnDef<KnowledgeResourceRow>[]>(
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
            />
          ) : null,
        cell: ({ row }) => {
          if (!showSelectionColumn) return null
          const { node, parentKeys } = row.original
          if (node.kind === 'document') {
            const document = node.document
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
          }

          if (!canSelectFolders) return null
          const coveredByAncestor = parentKeys.some(key => {
            const folderId = Number(key.replace('folder:', ''))
            return selectedFolderIds.has(folderId)
          })
          const directlySelected = selectedFolderIds.has(node.folderId)
          const partiallySelected =
            !directlySelected &&
            !coveredByAncestor &&
            (hasSelectedDescendantDocument(node, selectedDocumentIds) ||
              hasSelectedDescendantFolder(node, selectedFolderIds))
          const checked: boolean | 'indeterminate' =
            directlySelected || coveredByAncestor
              ? true
              : partiallySelected
                ? 'indeterminate'
                : false

          return (
            <Checkbox
              checked={checked}
              disabled={coveredByAncestor || node.documentCount === 0}
              onCheckedChange={nextChecked => onSelectFolder?.(node.folderId, nextChecked === true)}
              onClick={event => event.stopPropagation()}
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary disabled:opacity-60"
              data-testid={`folder-checkbox-${node.folderId}`}
            />
          )
        },
      },
      {
        id: 'name',
        accessorFn: row => row.node.name,
        header: () => t('document.document.columns.name'),
        size: 280,
        minSize: 200,
        maxSize: 520,
        cell: ({ row }) => {
          const { node, depth } = row.original
          const indent = depth * 16
          if (node.kind === 'document') {
            const document = node.document
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
              <div
                className="flex items-center gap-2 overflow-hidden min-w-0"
                style={indent > 0 ? { paddingLeft: `${indent}px` } : undefined}
              >
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
                      window.open(sourceUrl, '_blank', 'noopener,noreferrer')
                    }}
                    title={t('document.document.openLink')}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )
          }

          const isExpanded = expandedKeys.has(node.key)
          return (
            <div
              className="flex items-center gap-2 overflow-hidden min-w-0"
              style={indent > 0 ? { paddingLeft: `${indent}px` } : undefined}
            >
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-primary/10 hover:text-primary"
                onClick={event => {
                  event.stopPropagation()
                  toggleFolder(node.key)
                }}
                aria-label={
                  isExpanded ? t('document.folder.collapse') : t('document.folder.expand')
                }
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 flex-shrink-0 text-amber-500" />
              ) : (
                <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
              )}
              <TooltipProvider>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {node.name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs break-all">{node.name}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <span className="flex-shrink-0 text-xs text-text-muted">
                {t('document.folder.docCount', { count: node.documentCount })}
              </span>
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
          const node = row.original.node
          if (node.kind === 'document') {
            const document = node.document
            if (!(canManage?.(document) ?? true)) return null
            return (
              <button
                className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors"
                onClick={event => {
                  event.stopPropagation()
                  onEdit?.(document)
                }}
                title={t('common:actions.edit')}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )
          }

          if (!canManageFolders || !onRenameFolder) return null
          return (
            <button
              className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors"
              title={t('document.folder.rename')}
              onClick={event => {
                event.stopPropagation()
                onRenameFolder(node.folderId, node.name)
              }}
              data-testid={`rename-folder-${node.folderId}`}
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
          const node = row.original.node
          if (node.kind === 'folder') {
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
          const document = node.document
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
          const node = row.original.node
          if (node.kind === 'folder') return <span className="text-xs text-text-muted">-</span>
          const document = node.document
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
          const node = row.original.node
          if (node.kind === 'folder') return <span className="text-xs text-text-muted">-</span>
          return (
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="block text-xs text-text-muted truncate">
                    {node.document.created_by || '-'}
                  </span>
                </TooltipTrigger>
                {node.document.created_by && (
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{node.document.created_by}</p>
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
          const node = row.original.node
          const value = node.kind === 'folder' ? node.createdAt : node.document.created_at
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
          const node = row.original.node
          if (node.kind === 'folder') {
            return <span className="text-xs text-text-muted">{formatDateTime(node.updatedAt)}</span>
          }
          return (
            <span className="text-xs text-text-muted">
              {node.document.updated_at === node.document.created_at
                ? '-'
                : formatDateTime(node.document.updated_at)}
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
          const node = row.original.node
          if (node.kind === 'folder') return <span className="text-xs text-text-muted">-</span>
          const document = node.document
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
          const node = row.original.node
          if (node.kind === 'folder') {
            if (!canManageFolders) return null
            return (
              <div className="flex items-center justify-center gap-1">
                {onCreateFolder && (
                  <button
                    className="p-1 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                    title={t('document.folder.create')}
                    onClick={event => {
                      event.stopPropagation()
                      onCreateFolder(node.folderId)
                    }}
                    data-testid={`create-subfolder-${node.folderId}`}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                )}
                {onDeleteFolder && (
                  <button
                    className="p-1 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                    title={t('document.folder.delete')}
                    onClick={event => {
                      event.stopPropagation()
                      onDeleteFolder(node.folderId, node.name)
                    }}
                    data-testid={`delete-folder-${node.folderId}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )
          }

          const document = node.document
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

          return (
            <div className="flex items-center justify-center gap-1">
              {onMove && (
                <button
                  className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                  onClick={event => {
                    event.stopPropagation()
                    onMove(document)
                  }}
                  title={t('document.folder.moveDocument')}
                  data-testid="move-button"
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
                  title={
                    refreshingDocId === document.id
                      ? t('document.upload.web.refetching')
                      : t('document.upload.web.refetch')
                  }
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
                  title={t('document.document.reindex')}
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
                  title={t('document.document.download')}
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
                  title={t('common:actions.delete')}
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
      canSelectFolders,
      expandedKeys,
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
      onSelectFolder,
      ragConfigured,
      refreshingDocId,
      reindexingDocId,
      selectAllLabel,
      selectedDocumentIds,
      selectedFolderIds,
      showSelectionColumn,
      t,
      toggleFolder,
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
    state: {
      sorting,
      columnSizing,
      columnVisibility,
    },
    manualSorting: true,
    columnResizeMode: 'onChange',
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.node.key,
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
      : tableRows.map((_, index) => ({
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
      const { node } = row.original
      return (
        <div
          className={`grid items-center gap-4 px-4 py-3 transition-colors border-b border-border min-w-[880px] ${
            node.kind === 'folder'
              ? activeFolderId === node.folderId
                ? 'bg-primary/10 text-primary cursor-pointer'
                : 'bg-surface/50 hover:bg-surface cursor-pointer'
              : `bg-base hover:bg-surface group ${onViewDetail ? 'cursor-pointer' : ''}`
          }`}
          style={{ gridTemplateColumns }}
          onClick={() => {
            if (node.kind === 'folder') {
              onActivateFolder?.(node.folderId)
            } else {
              onViewDetail?.(node.document)
            }
          }}
          role={node.kind === 'folder' ? 'button' : undefined}
          tabIndex={node.kind === 'folder' ? 0 : undefined}
          aria-pressed={node.kind === 'folder' ? activeFolderId === node.folderId : undefined}
          onKeyDown={event => {
            if (node.kind !== 'folder' || event.currentTarget !== event.target) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onActivateFolder?.(node.folderId)
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
    [activeFolderId, gridTemplateColumns, onActivateFolder, onViewDetail]
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
        className="max-h-[70vh] overflow-y-auto"
        data-testid="knowledge-document-treegrid-virtual-scroll"
      >
        <div
          className="relative"
          style={{
            height: `${totalSize}px`,
          }}
        >
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
