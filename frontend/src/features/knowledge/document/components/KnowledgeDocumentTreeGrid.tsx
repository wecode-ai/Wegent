// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReactTable, getCoreRowModel, type ColumnDef } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { DocumentItem } from './DocumentItem'
import type { KnowledgeResourceNode, KnowledgeResourceTreeIndex } from '../utils/resource-tree'
import {
  flattenKnowledgeResourceRows,
  getDefaultExpandedFolderKeys,
  getFolderPathKeys,
  getResultDocumentFolderKeys,
} from '../utils/resource-tree'

interface KnowledgeDocumentTreeGridProps {
  nodes: KnowledgeResourceNode[]
  treeIndex: KnowledgeResourceTreeIndex
  folders: KnowledgeFolder[]
  documents: KnowledgeDocument[]
  gridTemplateColumns: string
  showSelectionColumn: boolean
  showActionsColumn: boolean
  nameColumnWidth?: number
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

export function KnowledgeDocumentTreeGrid({
  nodes,
  treeIndex,
  folders,
  documents,
  gridTemplateColumns,
  showSelectionColumn,
  showActionsColumn,
  nameColumnWidth,
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
  ragConfigured,
}: KnowledgeDocumentTreeGridProps) {
  const { t } = useTranslation('knowledge')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

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
  const columns = useMemo<ColumnDef<(typeof rows)[number]>[]>(
    () => [
      { id: 'selection' },
      { id: 'name', accessorFn: row => row.node.name },
      { id: 'quickAction' },
      { id: 'type' },
      { id: 'size' },
      { id: 'createdBy' },
      { id: 'createdAt' },
      { id: 'updatedAt' },
      { id: 'indexStatus' },
      { id: 'actions' },
    ],
    []
  )
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.node.key,
  })
  const tableRows = table.getRowModel().rows
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

  const renderRow = useCallback(
    (row: (typeof rows)[number]) => {
      const { node, depth, parentKeys } = row
      if (node.kind === 'document') {
        const document = node.document
        return (
          <DocumentItem
            document={document}
            indent={depth * 16}
            onViewDetail={onViewDetail ? () => onViewDetail(document) : undefined}
            onEdit={onEdit ? () => onEdit(document) : undefined}
            onDelete={onDelete ? () => onDelete(document) : undefined}
            onRefresh={onRefresh ? () => onRefresh(document) : undefined}
            onReindex={onReindex ? () => onReindex(document) : undefined}
            onMove={onMove ? () => onMove(document) : undefined}
            isRefreshing={refreshingDocId === document.id}
            isReindexing={reindexingDocId === document.id}
            canManage={canManage?.(document) ?? true}
            canSelect={canSelect?.(document) ?? false}
            showBorder={true}
            selected={selectedDocumentIds.has(document.id)}
            includedInFolderScope={includedInFolderScope?.(document) ?? false}
            onSelect={onSelect}
            compact={false}
            ragConfigured={ragConfigured}
            nameColumnWidth={nameColumnWidth}
            showActionsColumn={showActionsColumn}
          />
        )
      }

      const isExpanded = expandedKeys.has(node.key)
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
      const folderChecked: boolean | 'indeterminate' =
        directlySelected || coveredByAncestor ? true : partiallySelected ? 'indeterminate' : false
      const folderSelectionDisabled = coveredByAncestor || node.documentCount === 0
      const indent = depth * 16

      return (
        <div
          className={`grid items-center gap-4 px-4 py-3 transition-colors cursor-pointer border-b border-border min-w-[880px] ${
            activeFolderId === node.folderId
              ? 'bg-primary/10 text-primary'
              : 'bg-surface/50 hover:bg-surface'
          }`}
          style={{ gridTemplateColumns }}
          onClick={() => onActivateFolder?.(node.folderId)}
          role="button"
          tabIndex={0}
          aria-pressed={activeFolderId === node.folderId}
          onKeyDown={event => {
            if (event.currentTarget !== event.target) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onActivateFolder?.(node.folderId)
            }
          }}
        >
          {showSelectionColumn && (
            <div onClick={event => event.stopPropagation()}>
              {canSelectFolders && (
                <Checkbox
                  checked={folderChecked}
                  disabled={folderSelectionDisabled}
                  onCheckedChange={checked => onSelectFolder?.(node.folderId, checked === true)}
                  className="data-[state=checked]:bg-primary data-[state=checked]:border-primary disabled:opacity-60"
                  data-testid={`folder-checkbox-${node.folderId}`}
                />
              )}
            </div>
          )}

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
              aria-label={isExpanded ? t('document.folder.collapse') : t('document.folder.expand')}
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

          <div className="flex items-center justify-end gap-1">
            {canManageFolders && onRenameFolder && (
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
            )}
          </div>
          <div className="text-center min-w-0">
            <Badge
              variant="default"
              size="sm"
              className="bg-amber-500/10 text-amber-700 border-amber-500/20"
            >
              {t('document.folder.folderType')}
            </Badge>
          </div>
          <div className="text-center min-w-0">
            <span className="text-xs text-text-muted">-</span>
          </div>
          <div className="text-center min-w-0">
            <span className="text-xs text-text-muted">-</span>
          </div>
          <div className="text-center min-w-0">
            <span className="text-xs text-text-muted">{formatDateTime(node.createdAt)}</span>
          </div>
          <div className="text-center min-w-0">
            <span className="text-xs text-text-muted">{formatDateTime(node.updatedAt)}</span>
          </div>
          <div className="text-center min-w-0">
            <span className="text-xs text-text-muted">-</span>
          </div>
          {showActionsColumn && (
            <div className="flex items-center justify-center gap-1">
              {canManageFolders && onCreateFolder && (
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
              {canManageFolders && onDeleteFolder && (
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
          )}
        </div>
      )
    },
    [
      activeFolderId,
      canManage,
      canManageFolders,
      canSelect,
      canSelectFolders,
      expandedKeys,
      gridTemplateColumns,
      includedInFolderScope,
      nameColumnWidth,
      onActivateFolder,
      onCreateFolder,
      onDelete,
      onDeleteFolder,
      onEdit,
      onMove,
      onRefresh,
      onReindex,
      onRenameFolder,
      onSelect,
      onSelectFolder,
      onViewDetail,
      ragConfigured,
      refreshingDocId,
      reindexingDocId,
      selectedDocumentIds,
      selectedFolderIds,
      showActionsColumn,
      showSelectionColumn,
      t,
      toggleFolder,
    ]
  )

  return (
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
              {renderRow(tableRow.original)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
