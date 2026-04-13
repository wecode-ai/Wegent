// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { DocumentItem } from './DocumentItem'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

/** A node in the folder tree: either a folder or a leaf document */
interface FolderNode {
  type: 'folder'
  name: string
  /** Full path from root, e.g. "docs/api" */
  path: string
  children: TreeNode[]
}

interface DocumentNode {
  type: 'document'
  /** Display name (last segment after splitting by '/') */
  displayName: string
  document: KnowledgeDocument
}

type TreeNode = FolderNode | DocumentNode

/**
 * Build a tree structure from a flat list of documents.
 * Documents whose name contains '/' are placed into nested folders.
 * Documents without '/' are placed at the root level.
 */
function buildTree(documents: KnowledgeDocument[]): TreeNode[] {
  const root: TreeNode[] = []
  // Map from folder path to FolderNode for quick lookup
  const folderMap = new Map<string, FolderNode>()

  const getOrCreateFolder = (segments: string[], parentChildren: TreeNode[]): FolderNode => {
    const path = segments.join('/')
    if (folderMap.has(path)) {
      return folderMap.get(path)!
    }
    const folderNode: FolderNode = {
      type: 'folder',
      name: segments[segments.length - 1],
      path,
      children: [],
    }
    folderMap.set(path, folderNode)
    parentChildren.push(folderNode)
    return folderNode
  }

  for (const doc of documents) {
    const parts = doc.name.split('/')
    if (parts.length === 1) {
      // No folder - place at root
      root.push({
        type: 'document',
        displayName: doc.name,
        document: doc,
      })
    } else {
      // Navigate/create folder hierarchy
      let currentChildren = root
      for (let i = 0; i < parts.length - 1; i++) {
        const pathSegments = parts.slice(0, i + 1)
        const folder = getOrCreateFolder(pathSegments, currentChildren)
        currentChildren = folder.children
      }
      // Add document as leaf
      currentChildren.push({
        type: 'document',
        displayName: parts[parts.length - 1],
        document: doc,
      })
    }
  }

  return root
}

interface FolderRowProps {
  node: FolderNode
  depth: number
  compact: boolean
  expanded: boolean
  onToggle: (path: string) => void
}

function FolderRow({ node, depth, compact, expanded, onToggle }: FolderRowProps) {
  const { t } = useTranslation('knowledge')
  const indent = depth * (compact ? 12 : 16)

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
        <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
          {t('document.folder.docCount', { count: countDocuments(node) })}
        </span>
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
      <span className="text-xs text-text-muted ml-2">
        {t('document.folder.docCount', { count: countDocuments(node) })}
      </span>
    </div>
  )
}

/** Count total documents under a folder node (recursive) */
function countDocuments(node: FolderNode): number {
  let count = 0
  for (const child of node.children) {
    if (child.type === 'document') {
      count++
    } else {
      count += countDocuments(child)
    }
  }
  return count
}

interface FolderTreeNodeProps {
  node: TreeNode
  depth: number
  compact: boolean
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  // DocumentItem props
  onViewDetail?: (doc: KnowledgeDocument) => void
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onReindex?: (doc: KnowledgeDocument) => void
  isRefreshing?: (docId: number) => boolean
  isReindexing?: (docId: number) => boolean
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  selected?: (docId: number) => boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
  nameColumnWidth?: number
  showBorder?: boolean
  isLast?: boolean
}

function FolderTreeNode({
  node,
  depth,
  compact,
  expandedFolders,
  onToggleFolder,
  onViewDetail,
  onEdit,
  onDelete,
  onRefresh,
  onReindex,
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
    // Override displayName: pass a modified document with the last path segment as name
    const docWithDisplayName = { ...doc, name: node.displayName }

    if (compact) {
      // Compact mode: indent via paddingLeft on wrapper
      return (
        <div style={{ paddingLeft: `${depth * 12}px` }}>
          <DocumentItem
            document={docWithDisplayName}
            onViewDetail={onViewDetail ? () => onViewDetail(doc) : undefined}
            onEdit={onEdit ? () => onEdit(doc) : undefined}
            onDelete={onDelete ? () => onDelete(doc) : undefined}
            onRefresh={onRefresh ? () => onRefresh(doc) : undefined}
            onReindex={onReindex ? () => onReindex(doc) : undefined}
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

    // Normal (table) mode: DocumentItem handles its own px-4 padding.
    // We add extra left padding via a wrapper to indent nested documents.
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
      />
      {isExpanded && (
        <div>
          {node.children.map((child, idx) => (
            <FolderTreeNode
              key={child.type === 'folder' ? `folder:${child.path}` : `doc:${child.document.id}`}
              node={child}
              depth={depth + 1}
              compact={compact}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onViewDetail={onViewDetail}
              onEdit={onEdit}
              onDelete={onDelete}
              onRefresh={onRefresh}
              onReindex={onReindex}
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

export interface FolderTreeProps {
  documents: KnowledgeDocument[]
  compact?: boolean
  /**
   * Normal mode only: whether to wrap the tree in a bordered container.
   * Set to false when the parent already provides the border (e.g. DocumentList
   * renders the table header separately and wants a seamless join).
   * Defaults to true.
   */
  withBorder?: boolean
  onViewDetail?: (doc: KnowledgeDocument) => void
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onReindex?: (doc: KnowledgeDocument) => void
  refreshingDocId?: number | null
  reindexingDocId?: number | null
  canManage?: (doc: KnowledgeDocument) => boolean
  canSelect?: (doc: KnowledgeDocument) => boolean
  selectedIds?: Set<number>
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  ragConfigured?: boolean
  nameColumnWidth?: number
}

/**
 * FolderTree renders documents grouped into folders based on '/' in their names.
 * Supports both compact (card) and normal (table row) modes.
 */
export function FolderTree({
  documents,
  compact = false,
  withBorder = true,
  onViewDetail,
  onEdit,
  onDelete,
  onRefresh,
  onReindex,
  refreshingDocId,
  reindexingDocId,
  canManage,
  canSelect,
  selectedIds,
  onSelect,
  ragConfigured,
  nameColumnWidth,
}: FolderTreeProps) {
  const tree = useMemo(() => buildTree(documents), [documents])

  // Collect all folder paths for default-expand logic
  const allFolderPaths = useMemo(() => {
    const paths: string[] = []
    const collect = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder') {
          paths.push(node.path)
          collect(node.children)
        }
      }
    }
    collect(tree)
    return paths
  }, [tree])

  // Default: all folders expanded
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(allFolderPaths))

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
            key={node.type === 'folder' ? `folder:${node.path}` : `doc:${node.document.id}`}
            node={node}
            depth={0}
            compact={true}
            expandedFolders={expandedFolders}
            onToggleFolder={handleToggleFolder}
            onViewDetail={onViewDetail}
            onEdit={onEdit}
            onDelete={onDelete}
            onRefresh={onRefresh}
            onReindex={onReindex}
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
      key={node.type === 'folder' ? `folder:${node.path}` : `doc:${node.document.id}`}
      node={node}
      depth={0}
      compact={false}
      expandedFolders={expandedFolders}
      onToggleFolder={handleToggleFolder}
      onViewDetail={onViewDetail}
      onEdit={onEdit}
      onDelete={onDelete}
      onRefresh={onRefresh}
      onReindex={onReindex}
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
