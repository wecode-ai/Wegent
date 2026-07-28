// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { DocumentItem } from './DocumentItem'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

/** A node in the document browser: real folder or current document result */
interface FolderNode {
  type: 'api-folder'
  id: number
  name: string
  path: string
  children: TreeNode[]
  documentCount: number
  created_at?: string
  updated_at?: string
}

interface DocumentNode {
  type: 'document'
  displayName: string
  document: KnowledgeDocument
}

type TreeNode = FolderNode | DocumentNode

interface FolderTreeProps {
  /** API folders from knowledge base */
  folders: KnowledgeFolder[]
  /** All documents in the knowledge base */
  documents: KnowledgeDocument[]
  compact?: boolean
  withBorder?: boolean
  onViewDetail?: (doc: KnowledgeDocument) => void
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onReindex?: (doc: KnowledgeDocument) => void
  onReanalyze?: (doc: KnowledgeDocument) => void
  onMove?: (doc: KnowledgeDocument) => void
  refreshingDocId?: number | null
  reindexingDocId?: number | null
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  selectedIds?: Set<number>
  includedInFolderScope?: (doc: KnowledgeDocument) => boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
  nameColumnWidth?: number
  showActionsColumn?: boolean
  /** Folder CRUD handlers */
  onCreateFolder?: (parentId: number) => void
  onRenameFolder?: (folderId: number, currentName: string) => void
  onDeleteFolder?: (folderId: number, folderName: string) => void
  /** Whether the user can manage folders (permission from KB) */
  canManageFolders?: boolean
  /** Whether folders can be selected for batch operations (e.g., transfer) */
  canSelectFolders?: boolean
  /** Set of selected folder IDs (only API folders with isApiFolder=true) */
  selectedFolderIds?: Set<number>
  /** Callback when a folder is selected or deselected */
  onSelectFolder?: (folderId: number, selected: boolean) => void
  activeFolderId?: number
  onActivateFolder?: (folderId: number) => void
  expandAllFolders?: boolean
}

export type SortField = 'name' | 'size' | 'createdAt' | 'updatedAt'
export type SortOrder = 'asc' | 'desc'

function toDocumentNode(doc: KnowledgeDocument): DocumentNode {
  return {
    type: 'document',
    displayName: doc.name,
    document: doc,
  }
}

/** Convert API folder nodes to visible nodes and attach current query results by folder_id. */
function convertFolderToNode(
  folder: KnowledgeFolder,
  documentsByFolderId: Map<number, KnowledgeDocument[]>
): FolderNode {
  const childFolderNodes = folder.children.map(child =>
    convertFolderToNode(child, documentsByFolderId)
  )
  const directDocumentNodes = (documentsByFolderId.get(folder.id) ?? []).map(toDocumentNode)

  return {
    type: 'api-folder',
    id: folder.id,
    name: folder.name,
    path: `folder:${folder.id}`,
    children: [...childFolderNodes, ...directDocumentNodes],
    documentCount: folder.total_document_count ?? folder.document_count,
    created_at: folder.created_at,
    updated_at: folder.updated_at,
  }
}

/**
 * Build the visible tree from stable API folders and current document results.
 * Legacy "/" splitting is intentionally not used; "/" remains part of the file name.
 */
function buildMergedTree(folders: KnowledgeFolder[], documents: KnowledgeDocument[]): TreeNode[] {
  const documentsByFolderId = new Map<number, KnowledgeDocument[]>()
  for (const doc of documents) {
    const folderId = doc.folder_id ?? 0
    documentsByFolderId.set(folderId, [...(documentsByFolderId.get(folderId) ?? []), doc])
  }

  const folderNodes = folders.map(folder => convertFolderToNode(folder, documentsByFolderId))
  const knownFolderIds = new Set<number>()
  const collectFolderIds = (items: KnowledgeFolder[]) => {
    for (const folder of items) {
      knownFolderIds.add(folder.id)
      collectFolderIds(folder.children)
    }
  }
  collectFolderIds(folders)

  const rootDocuments = (documentsByFolderId.get(0) ?? []).map(toDocumentNode)
  const orphanDocuments = documents
    .filter(doc => doc.folder_id !== 0 && !knownFolderIds.has(doc.folder_id))
    .map(toDocumentNode)

  return [...folderNodes, ...rootDocuments, ...orphanDocuments]
}

function findFolderPathIds(
  folders: KnowledgeFolder[],
  targetId: number | undefined,
  path: number[] = []
): number[] {
  if (targetId === undefined) return []
  for (const folder of folders) {
    const nextPath = [...path, folder.id]
    if (folder.id === targetId) {
      return nextPath
    }
    const childPath = findFolderPathIds(folder.children, targetId, nextPath)
    if (childPath.length > 0) {
      return childPath
    }
  }
  return []
}

/** Generate a stable key for a tree node based on its type */
function treeNodeKey(node: TreeNode): string {
  if (node.type === 'document') {
    return `doc:${(node as DocumentNode).document.id}`
  }
  return `folder:${node.path}`
}

interface FolderRowProps {
  node: FolderNode
  depth: number
  compact: boolean
  expanded: boolean
  onToggle: (path: string) => void
  onCreateFolder?: (parentId: number) => void
  onRenameFolder?: (folderId: number, currentName: string) => void
  onDeleteFolder?: (folderId: number, folderName: string) => void
  canManageFolders?: boolean
  /** Folder selection props */
  canSelectFolders?: boolean
  folderChecked?: boolean | 'indeterminate'
  folderSelectionDisabled?: boolean
  onFolderCheck?: (checked: boolean) => void
  active?: boolean
  onActivate?: (folderId: number) => void
}

function FolderRow({
  node,
  depth,
  compact,
  expanded,
  onToggle,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  canManageFolders,
  canSelectFolders,
  folderChecked,
  folderSelectionDisabled,
  onFolderCheck,
  active,
  onActivate,
}: FolderRowProps) {
  const { t } = useTranslation('knowledge')
  const indent = depth * (compact ? 12 : 16)
  const hasChildren = node.children.length > 0
  const effectiveExpanded = expanded && hasChildren

  const folderActions = canManageFolders ? (
    <span
      className="flex items-center gap-1 ml-auto flex-shrink-0"
      onClick={e => e.stopPropagation()}
    >
      {onCreateFolder && (
        <button
          className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
          title={t('document.folder.create')}
          onClick={() => onCreateFolder(node.id)}
          data-testid={`create-subfolder-${node.id}`}
        >
          <FolderPlus className="w-3.5 h-3.5" />
        </button>
      )}
      {onRenameFolder && (
        <button
          className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
          title={t('document.folder.rename')}
          onClick={() => onRenameFolder(node.id, node.name)}
          data-testid={`rename-folder-${node.id}`}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
      {onDeleteFolder && (
        <button
          className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
          title={t('document.folder.delete')}
          onClick={() => onDeleteFolder(node.id, node.name)}
          data-testid={`delete-folder-${node.id}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </span>
  ) : null

  // Folder checkbox represents a backend-resolved folder scope, not current-page docs.
  const folderCheckbox = canSelectFolders ? (
    <Checkbox
      checked={folderChecked}
      disabled={folderSelectionDisabled || node.documentCount === 0}
      onCheckedChange={checked => {
        onFolderCheck?.(checked === true)
      }}
      onClick={e => e.stopPropagation()}
      className="data-[state=checked]:bg-primary data-[state=checked]:border-primary flex-shrink-0 disabled:opacity-60"
      data-testid={`folder-checkbox-${node.id}`}
    />
  ) : null
  const canActivate = Boolean(onActivate)

  if (compact) {
    return (
      <div
        role={canActivate ? 'button' : undefined}
        tabIndex={canActivate ? 0 : undefined}
        aria-pressed={canActivate ? active : undefined}
        className={`flex items-center gap-2 w-full px-2 py-2 rounded-lg transition-colors text-left ${
          canActivate ? 'cursor-pointer' : ''
        } ${active ? 'bg-primary/10 text-primary' : 'hover:bg-surface'}`}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={canActivate ? () => onActivate?.(node.id) : undefined}
        onKeyDown={
          canActivate
            ? e => {
                if (e.currentTarget !== e.target) {
                  return
                }
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivate?.(node.id)
                }
              }
            : undefined
        }
        title={node.name}
      >
        {folderCheckbox}
        {hasChildren ? (
          effectiveExpanded ? (
            <ChevronDown
              className="w-3 h-3 text-text-muted flex-shrink-0"
              onClick={e => {
                e.stopPropagation()
                onToggle(node.path)
              }}
            />
          ) : (
            <ChevronRight
              className="w-3 h-3 text-text-muted flex-shrink-0"
              onClick={e => {
                e.stopPropagation()
                onToggle(node.path)
              }}
            />
          )
        ) : null}
        {effectiveExpanded ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
        )}
        <span className="min-w-0 truncate text-xs font-medium text-text-primary">{node.name}</span>
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {t('document.folder.docCount', { count: node.documentCount })}
        </span>
        {folderActions}
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 transition-colors border-b border-border min-w-[880px] ${
        canActivate ? 'cursor-pointer' : ''
      } ${active ? 'bg-primary/10 text-primary' : 'bg-surface/50 hover:bg-surface'}`}
      style={{ paddingLeft: `${16 + indent}px` }}
      onClick={canActivate ? () => onActivate?.(node.id) : undefined}
      role={canActivate ? 'button' : undefined}
      tabIndex={canActivate ? 0 : undefined}
      aria-pressed={canActivate ? active : undefined}
      onKeyDown={
        canActivate
          ? e => {
              if (e.currentTarget !== e.target) {
                return
              }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onActivate?.(node.id)
              }
            }
          : undefined
      }
    >
      {folderCheckbox}
      {hasChildren ? (
        effectiveExpanded ? (
          <ChevronDown
            className="w-4 h-4 text-text-muted flex-shrink-0"
            onClick={e => {
              e.stopPropagation()
              onToggle(node.path)
            }}
          />
        ) : (
          <ChevronRight
            className="w-4 h-4 text-text-muted flex-shrink-0"
            onClick={e => {
              e.stopPropagation()
              onToggle(node.path)
            }}
          />
        )
      ) : (
        <div className="w-4 h-4 flex-shrink-0" />
      )}
      {effectiveExpanded ? (
        <FolderOpen className="w-4 h-4 text-amber-500 flex-shrink-0" />
      ) : (
        <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
      )}
      <span className="min-w-0 truncate text-sm font-medium text-text-primary">{node.name}</span>
      <span className="flex-shrink-0 text-xs text-text-muted">
        {t('document.folder.docCount', { count: node.documentCount })}
      </span>
      {folderActions}
    </div>
  )
}

interface FolderTreeNodeProps {
  node: TreeNode
  depth: number
  compact: boolean
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  // Folder handlers
  onCreateFolder?: (parentId: number) => void
  onRenameFolder?: (folderId: number, currentName: string) => void
  onDeleteFolder?: (folderId: number, folderName: string) => void
  canManageFolders?: boolean
  // DocumentItem props
  onViewDetail?: (doc: KnowledgeDocument) => void
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onReindex?: (doc: KnowledgeDocument) => void
  onReanalyze?: (doc: KnowledgeDocument) => void
  onMove?: (doc: KnowledgeDocument) => void
  isRefreshing?: (docId: number) => boolean
  isReindexing?: (docId: number) => boolean
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  selected?: (docId: number) => boolean
  includedInFolderScope?: (doc: KnowledgeDocument) => boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
  nameColumnWidth?: number
  showActionsColumn?: boolean
  // Folder selection props
  canSelectFolders?: boolean
  selectedFolderIds?: Set<number>
  coveredBySelectedAncestorFolder?: boolean
  onSelectFolder?: (folderId: number, selected: boolean) => void
  activeFolderId?: number
  onActivateFolder?: (folderId: number) => void
}

function FolderTreeNode({
  node,
  depth,
  compact,
  expandedFolders,
  onToggleFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  canManageFolders,
  onViewDetail,
  onEdit,
  onDelete,
  onRefresh,
  onReindex,
  onReanalyze,
  onMove,
  isRefreshing,
  isReindexing,
  canManage,
  canSelect,
  selected,
  includedInFolderScope,
  onSelect,
  ragConfigured,
  nameColumnWidth,
  showActionsColumn,
  canSelectFolders,
  selectedFolderIds,
  coveredBySelectedAncestorFolder = false,
  onSelectFolder,
  activeFolderId,
  onActivateFolder,
}: FolderTreeNodeProps) {
  // Hooks must be called unconditionally (before any early returns)
  const handleFolderCheck = useCallback(
    (checked: boolean) => {
      if (node.type !== 'document') {
        onSelectFolder?.((node as FolderNode).id, checked)
      }
    },
    [node, onSelectFolder]
  )

  if (node.type === 'document') {
    const doc = node.document
    const docWithDisplayName = { ...doc, name: node.displayName }
    const includedByFolder = includedInFolderScope?.(doc) ?? false

    if (compact) {
      return (
        <div style={{ paddingLeft: `${depth * 12}px` }}>
          <DocumentItem
            document={docWithDisplayName}
            onViewDetail={onViewDetail ? () => onViewDetail(doc) : undefined}
            onEdit={onEdit ? () => onEdit(doc) : undefined}
            onDelete={onDelete ? () => onDelete(doc) : undefined}
            onRefresh={onRefresh ? () => onRefresh(doc) : undefined}
            onReindex={onReindex ? () => onReindex(doc) : undefined}
            onReanalyze={onReanalyze ? () => onReanalyze(doc) : undefined}
            onMove={onMove ? () => onMove(doc) : undefined}
            isRefreshing={isRefreshing?.(doc.id) ?? false}
            isReindexing={isReindexing?.(doc.id) ?? false}
            canManage={canManage?.(doc) ?? true}
            canSelect={canSelect?.(doc) ?? false}
            showBorder={false}
            selected={selected?.(doc.id) ?? false}
            includedInFolderScope={includedByFolder}
            onSelect={onSelect}
            compact={true}
            ragConfigured={ragConfigured}
            showActionsColumn={showActionsColumn}
          />
        </div>
      )
    }

    const indent = depth * 16
    return (
      <DocumentItem
        document={docWithDisplayName}
        indent={indent}
        onViewDetail={onViewDetail ? () => onViewDetail(doc) : undefined}
        onEdit={onEdit ? () => onEdit(doc) : undefined}
        onDelete={onDelete ? () => onDelete(doc) : undefined}
        onRefresh={onRefresh ? () => onRefresh(doc) : undefined}
        onReindex={onReindex ? () => onReindex(doc) : undefined}
        onReanalyze={onReanalyze ? () => onReanalyze(doc) : undefined}
        onMove={onMove ? () => onMove(doc) : undefined}
        isRefreshing={isRefreshing?.(doc.id) ?? false}
        isReindexing={isReindexing?.(doc.id) ?? false}
        canManage={canManage?.(doc) ?? true}
        canSelect={canSelect?.(doc) ?? false}
        showBorder={true}
        selected={selected?.(doc.id) ?? false}
        includedInFolderScope={includedByFolder}
        onSelect={onSelect}
        compact={false}
        ragConfigured={ragConfigured}
        nameColumnWidth={nameColumnWidth}
        showActionsColumn={showActionsColumn}
      />
    )
  }

  // Folder node
  const isExpanded = expandedFolders.has(node.path)
  const directlySelectedFolder = selectedFolderIds?.has(node.id) ?? false
  const folderChecked = coveredBySelectedAncestorFolder || directlySelectedFolder
  const folderSelectionDisabled = coveredBySelectedAncestorFolder
  const childCoveredBySelectedFolder = coveredBySelectedAncestorFolder || directlySelectedFolder

  return (
    <div>
      <FolderRow
        node={node}
        depth={depth}
        compact={compact}
        expanded={isExpanded}
        onToggle={onToggleFolder}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        canManageFolders={canManageFolders}
        canSelectFolders={canSelectFolders}
        folderChecked={folderChecked}
        folderSelectionDisabled={folderSelectionDisabled}
        onFolderCheck={handleFolderCheck}
        active={activeFolderId === node.id}
        onActivate={onActivateFolder}
      />
      {isExpanded && (
        <div>
          {node.children.map(child => (
            <FolderTreeNode
              key={treeNodeKey(child)}
              node={child}
              depth={depth + 1}
              compact={compact}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              canManageFolders={canManageFolders}
              onViewDetail={onViewDetail}
              onEdit={onEdit}
              onDelete={onDelete}
              onRefresh={onRefresh}
              onReindex={onReindex}
              onReanalyze={onReanalyze}
              onMove={onMove}
              isRefreshing={isRefreshing}
              isReindexing={isReindexing}
              canManage={canManage}
              canSelect={canSelect}
              selected={selected}
              includedInFolderScope={includedInFolderScope}
              onSelect={onSelect}
              ragConfigured={ragConfigured}
              nameColumnWidth={nameColumnWidth}
              canSelectFolders={canSelectFolders}
              selectedFolderIds={selectedFolderIds}
              coveredBySelectedAncestorFolder={childCoveredBySelectedFolder}
              onSelectFolder={onSelectFolder}
              activeFolderId={activeFolderId}
              onActivateFolder={onActivateFolder}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * FolderTree renders stable folder navigation and current document results.
 */
export function FolderTree({
  folders = [],
  documents,
  compact = false,
  withBorder = true,
  onViewDetail,
  onEdit,
  onDelete,
  onRefresh,
  onReindex,
  onReanalyze,
  onMove,
  refreshingDocId,
  reindexingDocId,
  canManage,
  canSelect,
  selectedIds,
  includedInFolderScope,
  onSelect,
  ragConfigured,
  nameColumnWidth,
  showActionsColumn,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  canManageFolders = false,
  canSelectFolders = false,
  selectedFolderIds,
  onSelectFolder,
  activeFolderId,
  onActivateFolder,
  expandAllFolders = false,
}: FolderTreeProps) {
  const tree = useMemo(() => buildMergedTree(folders, documents), [folders, documents])

  const defaultExpandedFolderPaths = useMemo(
    () => folders.map(folder => `folder:${folder.id}`),
    [folders]
  )
  const activeFolderPaths = useMemo(
    () => findFolderPathIds(folders, activeFolderId).map(id => `folder:${id}`),
    [folders, activeFolderId]
  )
  const resultDocumentFolderPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const document of documents) {
      for (const id of findFolderPathIds(folders, document.folder_id)) {
        paths.add(`folder:${id}`)
      }
    }
    return Array.from(paths)
  }, [folders, documents])

  const allFolderPaths = useMemo(() => {
    if (!expandAllFolders) return []
    const paths: string[] = []
    function walk(list: KnowledgeFolder[]) {
      for (const f of list) {
        paths.push(`folder:${f.id}`)
        if (f.children?.length) walk(f.children)
      }
    }
    walk(folders)
    return paths
  }, [folders, expandAllFolders])

  // Default: expand root-level folders only; active/result paths are expanded separately.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  useEffect(() => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      for (const path of defaultExpandedFolderPaths) {
        next.add(path)
      }
      return next
    })
  }, [defaultExpandedFolderPaths])

  useEffect(() => {
    if (activeFolderPaths.length === 0) return
    setExpandedFolders(prev => {
      const next = new Set(prev)
      for (const path of activeFolderPaths) {
        next.add(path)
      }
      return next
    })
  }, [activeFolderPaths])

  useEffect(() => {
    if (resultDocumentFolderPaths.length === 0) return
    setExpandedFolders(prev => {
      const next = new Set(prev)
      for (const path of resultDocumentFolderPaths) {
        next.add(path)
      }
      return next
    })
  }, [resultDocumentFolderPaths])

  useEffect(() => {
    if (allFolderPaths.length === 0) return
    setExpandedFolders(prev => {
      const next = new Set(prev)
      for (const path of allFolderPaths) {
        next.add(path)
      }
      return next
    })
  }, [allFolderPaths])

  const handleToggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  if (compact) {
    return (
      <div className="space-y-0.5">
        {tree.map(node => (
          <FolderTreeNode
            key={node.type === 'document' ? `doc:${node.document.id}` : `folder:${node.path}`}
            node={node}
            depth={0}
            compact={true}
            expandedFolders={expandedFolders}
            onToggleFolder={handleToggleFolder}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            canManageFolders={canManageFolders}
            onViewDetail={onViewDetail}
            onEdit={onEdit}
            onDelete={onDelete}
            onRefresh={onRefresh}
            onReindex={onReindex}
            onReanalyze={onReanalyze}
            onMove={onMove}
            isRefreshing={id => refreshingDocId === id}
            isReindexing={id => reindexingDocId === id}
            canManage={canManage}
            canSelect={canSelect}
            selected={id => selectedIds?.has(id) ?? false}
            includedInFolderScope={includedInFolderScope}
            onSelect={onSelect}
            ragConfigured={ragConfigured}
            showActionsColumn={showActionsColumn}
            canSelectFolders={canSelectFolders}
            selectedFolderIds={selectedFolderIds}
            onSelectFolder={onSelectFolder}
            activeFolderId={activeFolderId}
            onActivateFolder={onActivateFolder}
          />
        ))}
      </div>
    )
  }

  // Normal (table) mode
  const treeNodes = tree.map(node => (
    <FolderTreeNode
      key={node.type === 'document' ? `doc:${node.document.id}` : `folder:${node.path}`}
      node={node}
      depth={0}
      compact={false}
      expandedFolders={expandedFolders}
      onToggleFolder={handleToggleFolder}
      onCreateFolder={onCreateFolder}
      onRenameFolder={onRenameFolder}
      onDeleteFolder={onDeleteFolder}
      canManageFolders={canManageFolders}
      onViewDetail={onViewDetail}
      onEdit={onEdit}
      onDelete={onDelete}
      onRefresh={onRefresh}
      onReindex={onReindex}
      onReanalyze={onReanalyze}
      onMove={onMove}
      isRefreshing={id => refreshingDocId === id}
      isReindexing={id => reindexingDocId === id}
      canManage={canManage}
      canSelect={canSelect}
      selected={id => selectedIds?.has(id) ?? false}
      includedInFolderScope={includedInFolderScope}
      onSelect={onSelect}
      ragConfigured={ragConfigured}
      nameColumnWidth={nameColumnWidth}
      showActionsColumn={showActionsColumn}
      canSelectFolders={canSelectFolders}
      selectedFolderIds={selectedFolderIds}
      onSelectFolder={onSelectFolder}
      activeFolderId={activeFolderId}
      onActivateFolder={onActivateFolder}
    />
  ))

  if (withBorder) {
    return <div className="border border-border rounded-lg overflow-x-auto">{treeNodes}</div>
  }

  return <>{treeNodes}</>
}
