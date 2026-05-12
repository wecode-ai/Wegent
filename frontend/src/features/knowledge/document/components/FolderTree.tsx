// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo, useEffect } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'
import { DocumentItem } from './DocumentItem'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

/** A node in the merged tree: folder, document, or a synthetic folder from document names */
interface FolderNode {
  type: 'folder' | 'api-folder'
  id: number
  name: string
  path: string
  children: TreeNode[]
  documentCount: number
  /** Whether this is a real folder from the API (enables CRUD operations) */
  isApiFolder: boolean
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
  onMove?: (doc: KnowledgeDocument) => void
  refreshingDocId?: number | null
  reindexingDocId?: number | null
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  selectedIds?: Set<number>
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
  nameColumnWidth?: number
  /** Folder CRUD handlers */
  onCreateFolder?: (parentId: number) => void
  onRenameFolder?: (folderId: number, currentName: string) => void
  onDeleteFolder?: (folderId: number, folderName: string) => void
  /** Whether the user can manage folders (permission from KB) */
  canManageFolders?: boolean
}

/**
 * Convert API folder nodes to TreeNode structure recursively.
 */
function convertFolderToNode(
  folder: KnowledgeFolder,
  docsByFolderId: Map<number, KnowledgeDocument[]>
): FolderNode {
  const folderDocs = docsByFolderId.get(folder.id) || []

  const children: TreeNode[] = [
    ...folderDocs.map(doc => ({
      type: 'document' as const,
      displayName: doc.name,
      document: doc,
    })),
    ...folder.children.map(child => convertFolderToNode(child, docsByFolderId)),
  ]

  // Count total documents recursively
  const totalDocs =
    folderDocs.length + folder.children.reduce((sum, c) => sum + c.document_count, 0)

  return {
    type: 'api-folder',
    id: folder.id,
    name: folder.name,
    path: `folder:${folder.id}`,
    children,
    documentCount: totalDocs,
    isApiFolder: true,
  }
}

/**
 * Build a merged tree from API folders and documents.
 *
 * Documents with folder_id = 0 go to root level.
 * Documents with folder_id > 0 go under the matching folder.
 * API folders form the hierarchy, and documents are leaf nodes within them.
 *
 * When no API folders exist, falls back to building a virtual tree
 * from document name paths (backward compatible '/' splitting).
 */
function buildMergedTree(folders: KnowledgeFolder[], documents: KnowledgeDocument[]): TreeNode[] {
  // Group documents: root (folder_id=0) vs folder-specific
  const rootDocs: KnowledgeDocument[] = []
  const docsByFolderId = new Map<number, KnowledgeDocument[]>()
  let hasAnyRealFolder = folders.length > 0

  for (const doc of documents) {
    if (doc.folder_id === 0) {
      rootDocs.push(doc)
    } else {
      const arr = docsByFolderId.get(doc.folder_id) || []
      arr.push(doc)
      docsByFolderId.set(doc.folder_id, arr)
      hasAnyRealFolder = true
    }
  }

  // If there are real folders from the API, use them to build the tree
  if (hasAnyRealFolder) {
    const tree: TreeNode[] = [
      ...rootDocs.map(doc => ({
        type: 'document' as const,
        displayName: doc.name,
        document: doc,
      })),
      ...folders.map(folder => convertFolderToNode(folder, docsByFolderId)),
    ]
    return tree
  }

  // Fallback: build virtual tree from document names (backward compat)
  return buildFallbackTree(documents)
}

/**
 * Build virtual tree by splitting document names on '/'.
 * This is the backward-compatible fallback when no real folders exist.
 */
function buildFallbackTree(documents: KnowledgeDocument[]): TreeNode[] {
  const root: TreeNode[] = []
  const folderMap = new Map<string, FolderNode>()

  const getOrCreateFolder = (segments: string[], parentChildren: TreeNode[]): FolderNode => {
    const path = segments.join('/')
    if (folderMap.has(path)) {
      return folderMap.get(path)!
    }
    const folderNode: FolderNode = {
      type: 'folder',
      id: 0,
      name: segments[segments.length - 1],
      path,
      children: [],
      documentCount: 0,
      isApiFolder: false,
    }
    folderMap.set(path, folderNode)
    parentChildren.push(folderNode)
    return folderNode
  }

  for (const doc of documents) {
    const parts = doc.name.split('/')
    if (parts.length === 1) {
      root.push({
        type: 'document',
        displayName: doc.name,
        document: doc,
      })
    } else {
      let currentChildren = root
      for (let i = 0; i < parts.length - 1; i++) {
        const pathSegments = parts.slice(0, i + 1)
        const folder = getOrCreateFolder(pathSegments, currentChildren)
        folder.documentCount++
        currentChildren = folder.children
      }
      currentChildren.push({
        type: 'document',
        displayName: parts[parts.length - 1],
        document: doc,
      })
    }
  }

  return root
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
}: FolderRowProps) {
  const { t } = useTranslation('knowledge')
  const indent = depth * (compact ? 12 : 16)
  const isApiFolder = node.isApiFolder

  const folderActions =
    isApiFolder && canManageFolders ? (
      <span
        className="flex items-center gap-0.5 ml-auto flex-shrink-0"
        onClick={e => e.stopPropagation()}
      >
        {onCreateFolder && (
          <button
            className="p-0.5 rounded hover:bg-border transition-colors"
            title={t('document.folder.create')}
            onClick={() => onCreateFolder(node.id)}
            data-testid={`create-subfolder-${node.id}`}
          >
            <FolderPlus className="w-3 h-3 text-text-muted" />
          </button>
        )}
        {onRenameFolder && (
          <button
            className="p-0.5 rounded hover:bg-border transition-colors"
            title={t('document.folder.rename')}
            onClick={() => onRenameFolder(node.id, node.name)}
            data-testid={`rename-folder-${node.id}`}
          >
            <Pencil className="w-3 h-3 text-text-muted" />
          </button>
        )}
        {onDeleteFolder && (
          <button
            className="p-0.5 rounded hover:bg-border transition-colors"
            title={t('document.folder.delete')}
            onClick={() => onDeleteFolder(node.id, node.name)}
            data-testid={`delete-folder-${node.id}`}
          >
            <Trash2 className="w-3 h-3 text-text-muted" />
          </button>
        )}
      </span>
    ) : null

  if (compact) {
    return (
      <button
        className="flex items-center gap-1.5 w-full px-2 py-1.5 hover:bg-surface rounded-lg transition-colors text-left"
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => onToggle(node.path)}
        title={node.name}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-muted flex-shrink-0" />
        )}
        {expanded ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
        )}
        <span className="text-xs font-medium text-text-primary truncate">{node.name}</span>
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {t('document.folder.docCount', { count: node.documentCount })}
        </span>
        {folderActions}
      </button>
    )
  }

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 bg-surface/50 hover:bg-surface transition-colors cursor-pointer border-b border-border min-w-[800px]"
      style={{ paddingLeft: `${16 + indent}px` }}
      onClick={() => onToggle(node.path)}
    >
      {expanded ? (
        <ChevronDown className="w-4 h-4 text-text-muted flex-shrink-0" />
      ) : (
        <ChevronRight className="w-4 h-4 text-text-muted flex-shrink-0" />
      )}
      {expanded ? (
        <FolderOpen className="w-4 h-4 text-amber-500 flex-shrink-0" />
      ) : (
        <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
      )}
      <span className="text-sm font-medium text-text-primary">{node.name}</span>
      <span className="text-xs text-text-muted">
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
  onMove?: (doc: KnowledgeDocument) => void
  isRefreshing?: (docId: number) => boolean
  isReindexing?: (docId: number) => boolean
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  selected?: (docId: number) => boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
  nameColumnWidth?: number
  isLast?: boolean
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
  onMove,
  isRefreshing,
  isReindexing,
  canManage,
  canSelect,
  selected,
  onSelect,
  ragConfigured,
  nameColumnWidth,
  isLast,
}: FolderTreeNodeProps) {
  if (node.type === 'document') {
    const doc = node.document
    const docWithDisplayName = { ...doc, name: node.displayName }

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
            onMove={onMove ? () => onMove(doc) : undefined}
            isRefreshing={isRefreshing?.(doc.id) ?? false}
            isReindexing={isReindexing?.(doc.id) ?? false}
            canManage={canManage?.(doc) ?? true}
            canSelect={canSelect?.(doc) ?? false}
            showBorder={false}
            selected={selected?.(doc.id) ?? false}
            onSelect={onSelect}
            compact={true}
            ragConfigured={ragConfigured}
          />
        </div>
      )
    }

    const extraIndent = depth * 16
    return (
      <div style={extraIndent > 0 ? { paddingLeft: `${extraIndent}px` } : undefined}>
        <DocumentItem
          document={docWithDisplayName}
          onViewDetail={onViewDetail ? () => onViewDetail(doc) : undefined}
          onEdit={onEdit ? () => onEdit(doc) : undefined}
          onDelete={onDelete ? () => onDelete(doc) : undefined}
          onRefresh={onRefresh ? () => onRefresh(doc) : undefined}
          onReindex={onReindex ? () => onReindex(doc) : undefined}
          onMove={onMove ? () => onMove(doc) : undefined}
          isRefreshing={isRefreshing?.(doc.id) ?? false}
          isReindexing={isReindexing?.(doc.id) ?? false}
          canManage={canManage?.(doc) ?? true}
          canSelect={canSelect?.(doc) ?? false}
          showBorder={!isLast}
          selected={selected?.(doc.id) ?? false}
          onSelect={onSelect}
          compact={false}
          ragConfigured={ragConfigured}
          nameColumnWidth={nameColumnWidth}
        />
      </div>
    )
  }

  // Folder node
  const isExpanded = expandedFolders.has(node.path)
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
      />
      {isExpanded && (
        <div>
          {node.children.map((child, idx) => (
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
              onMove={onMove}
              isRefreshing={isRefreshing}
              isReindexing={isReindexing}
              canManage={canManage}
              canSelect={canSelect}
              selected={selected}
              onSelect={onSelect}
              ragConfigured={ragConfigured}
              nameColumnWidth={nameColumnWidth}
              isLast={idx === node.children.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * FolderTree renders documents grouped into folders.
 *
 * When folders are provided from the API, it uses the real folder hierarchy.
 * When no folders exist, it falls back to building virtual folders from
 * document name paths (backward compatible '/' splitting).
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
  onMove,
  refreshingDocId,
  reindexingDocId,
  canManage,
  canSelect,
  selectedIds,
  onSelect,
  ragConfigured,
  nameColumnWidth,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  canManageFolders = false,
}: FolderTreeProps) {
  const tree = useMemo(() => buildMergedTree(folders, documents), [folders, documents])

  // Collect all folder paths for default-expand
  const allFolderPaths = useMemo(() => {
    const paths: string[] = []
    const collect = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder' || node.type === 'api-folder') {
          paths.push(node.path)
          collect(node.children)
        }
      }
    }
    collect(tree)
    return paths
  }, [tree])

  // Default: all folders expanded; sync when asynchronously loaded folders change
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  useEffect(() => {
    setExpandedFolders(new Set(allFolderPaths))
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
        {tree.map((node, idx) => (
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
            onMove={onMove}
            isRefreshing={id => refreshingDocId === id}
            isReindexing={id => reindexingDocId === id}
            canManage={canManage}
            canSelect={canSelect}
            selected={id => selectedIds?.has(id) ?? false}
            onSelect={onSelect}
            ragConfigured={ragConfigured}
            isLast={idx === tree.length - 1}
          />
        ))}
      </div>
    )
  }

  // Normal (table) mode
  const treeNodes = tree.map((node, idx) => (
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
      onMove={onMove}
      isRefreshing={id => refreshingDocId === id}
      isReindexing={id => reindexingDocId === id}
      canManage={canManage}
      canSelect={canSelect}
      selected={id => selectedIds?.has(id) ?? false}
      onSelect={onSelect}
      ragConfigured={ragConfigured}
      nameColumnWidth={nameColumnWidth}
      isLast={idx === tree.length - 1}
    />
  ))

  if (withBorder) {
    return <div className="border border-border rounded-lg overflow-x-auto">{treeNodes}</div>
  }

  return <div className="overflow-x-auto">{treeNodes}</div>
}
