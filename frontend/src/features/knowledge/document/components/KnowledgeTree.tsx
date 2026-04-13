// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeTree component renders the hierarchical tree of knowledge bases.
 * Includes search filtering, expand/collapse, and create actions.
 */

'use client'

import { useState, useMemo, useCallback } from 'react'
import {
  ChevronRight,
  ChevronDown,
  User,
  Users,
  Building2,
  BookOpen,
  Database,
  Plus,
  Search,
  UserCircle,
  Share2,
  Settings,
} from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useTranslation } from '@/hooks/useTranslation'
import type { TreeNode } from '../hooks/useKnowledgeTree'
import type { KnowledgeBase, KnowledgeBaseType } from '@/types/knowledge'
import type { Group } from '@/types/group'

interface KnowledgeTreeProps {
  /** Tree nodes data */
  nodes: TreeNode[]
  /** Currently selected KB ID */
  selectedKbId: number | null
  /** Whether tree data is loading */
  loading: boolean
  /** Expand state map */
  expandState: Record<string, boolean>
  /** Toggle node expand */
  onToggleExpand: (nodeId: string) => void
  /** Select a knowledge base */
  onSelectKb: (kb: KnowledgeBase) => void
  /** Create KB handler */
  onCreateKb: (
    scope: 'personal' | 'group' | 'organization',
    kbType: KnowledgeBaseType,
    groupName?: string
  ) => void
  /** Open group settings handler */
  onOpenGroupSettings?: (group: Group) => void
  /** Edit knowledge base handler */
  onEditKb?: (kb: KnowledgeBase) => void
  /** Whether current user can manage a specific group */
  canManageGroup?: (group: Group) => boolean
  /** Whether current user can manage a specific KB */
  canManageKb?: (kb: KnowledgeBase) => boolean
}

export function KnowledgeTree({
  nodes,
  selectedKbId,
  loading,
  expandState,
  onToggleExpand,
  onSelectKb,
  onCreateKb,
  onOpenGroupSettings,
  onEditKb,
  canManageGroup,
  canManageKb,
}: KnowledgeTreeProps) {
  const { t } = useTranslation('knowledge')
  const [searchQuery, setSearchQuery] = useState('')

  // Filter tree nodes based on search
  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) return nodes

    const query = searchQuery.toLowerCase()

    const filterNode = (node: TreeNode): TreeNode | null => {
      // For leaf nodes, check if name matches
      if (node.type === 'kb-leaf') {
        const matches =
          node.label.toLowerCase().includes(query) ||
          node.knowledgeBase?.description?.toLowerCase().includes(query)
        return matches ? node : null
      }

      // For non-leaf nodes, filter children
      if (node.children) {
        const filteredChildren = node.children
          .map(child => filterNode(child))
          .filter((child): child is TreeNode => child !== null)

        if (filteredChildren.length > 0) {
          return {
            ...node,
            children: filteredChildren,
            expanded: true, // Auto-expand when searching
          }
        }
      }

      return null
    }

    return nodes.map(node => filterNode(node)).filter((node): node is TreeNode => node !== null)
  }, [nodes, searchQuery])

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3">
          <SearchInput value={searchQuery} onChange={setSearchQuery} />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Spinner />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="knowledge-tree">
      {/* Search */}
      <div className="p-3 border-b border-border">
        <SearchInput value={searchQuery} onChange={setSearchQuery} />
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto py-1 custom-scrollbar">
        {filteredNodes.length === 0 && searchQuery ? (
          <div className="px-3 py-6 text-center text-sm text-text-muted">
            {t('document.tree.noResults')}
          </div>
        ) : (
          filteredNodes.map(node => (
            <TreeNodeItem
              key={node.id}
              node={node}
              depth={0}
              selectedKbId={selectedKbId}
              expandState={expandState}
              searchQuery={searchQuery}
              onToggleExpand={onToggleExpand}
              onSelectKb={onSelectKb}
              onCreateKb={onCreateKb}
              onOpenGroupSettings={onOpenGroupSettings}
              onEditKb={onEditKb}
              canManageGroup={canManageGroup}
              canManageKb={canManageKb}
            />
          ))
        )}
      </div>
    </div>
  )
}

// Search input
function SearchInput({ value, onChange }: { value: string; onChange: (val: string) => void }) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
      <input
        type="text"
        className="w-full h-8 pl-8 pr-3 text-xs bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder={t('document.tree.searchPlaceholder')}
        value={value}
        onChange={e => onChange(e.target.value)}
        data-testid="knowledge-tree-search"
      />
    </div>
  )
}

// Category icon mapping
function getCategoryIcon(icon?: string, className = 'w-4 h-4') {
  switch (icon) {
    case 'user':
      return <User className={`${className} text-primary`} />
    case 'users':
      return <Users className={`${className} text-primary`} />
    case 'building':
      return <Building2 className={`${className} text-primary`} />
    default:
      return null
  }
}

// KB type icon
// KB type icon
function getKbIcon(icon?: string, className = 'w-3.5 h-3.5') {
  if (icon === 'folder') {
    return <Database className={`${className} text-text-secondary`} />
  }
  return <BookOpen className={`${className} text-primary`} />
}
// Sub-category icon
function getSubCategoryIcon(nodeId: string, className = 'w-3.5 h-3.5') {
  if (nodeId.includes('created')) {
    return <UserCircle className={`${className} text-primary`} />
  }
  if (nodeId.includes('shared')) {
    return <Share2 className={`${className} text-text-secondary`} />
  }
  return null
}

// Create KB dropdown for a node
function CreateKbButton({
  scope,
  groupName,
  onCreateKb,
}: {
  scope: 'personal' | 'group' | 'organization'
  groupName?: string
  onCreateKb: (
    scope: 'personal' | 'group' | 'organization',
    kbType: KnowledgeBaseType,
    groupName?: string
  ) => void
}) {
  const { t } = useTranslation('knowledge')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="p-0.5 rounded hover:bg-muted text-text-muted hover:text-primary transition-colors"
          onClick={e => e.stopPropagation()}
          data-testid="create-kb-tree-button"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onClick={e => {
            e.stopPropagation()
            onCreateKb(scope, 'notebook', groupName)
          }}
          className="flex items-start gap-3 py-2"
        >
          <BookOpen className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium text-sm">{t('document.knowledgeBase.typeNotebook')}</div>
            <div className="text-xs text-text-muted">
              {t('document.knowledgeBase.notebookDesc')}
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={e => {
            e.stopPropagation()
            onCreateKb(scope, 'classic', groupName)
          }}
          className="flex items-start gap-3 py-2"
        >
          <Database className="w-4 h-4 text-text-secondary mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium text-sm">{t('document.knowledgeBase.typeClassic')}</div>
            <div className="text-xs text-text-muted">{t('document.knowledgeBase.classicDesc')}</div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Tree node item recursive component
interface TreeNodeItemProps {
  node: TreeNode
  depth: number
  selectedKbId: number | null
  expandState: Record<string, boolean>
  searchQuery: string
  onToggleExpand: (nodeId: string) => void
  onSelectKb: (kb: KnowledgeBase) => void
  onCreateKb: (
    scope: 'personal' | 'group' | 'organization',
    kbType: KnowledgeBaseType,
    groupName?: string
  ) => void
  onOpenGroupSettings?: (group: Group) => void
  onEditKb?: (kb: KnowledgeBase) => void
  canManageGroup?: (group: Group) => boolean
  canManageKb?: (kb: KnowledgeBase) => boolean
}

function TreeNodeItem({
  node,
  depth,
  selectedKbId,
  expandState,
  searchQuery,
  onToggleExpand,
  onSelectKb,
  onCreateKb,
  onOpenGroupSettings,
  onEditKb,
  canManageGroup,
  canManageKb,
}: TreeNodeItemProps) {
  const { t } = useTranslation('knowledge')
  const isExpanded = searchQuery
    ? (node.expanded ?? expandState[node.id] ?? false)
    : (expandState[node.id] ?? node.expanded ?? false)
  const hasChildren = node.children && node.children.length > 0
  const isLeaf = node.type === 'kb-leaf'
  const isSelected = isLeaf && node.knowledgeBase?.id === selectedKbId
  const paddingLeft = 8 + depth * 16

  // Determine if we can create KBs in this node
  const showCreate = (() => {
    if (node.type === 'category-root' && node.canCreate) return true
    if (node.type === 'category-sub' && node.canCreate) return true
    if (node.type === 'group-item' && node.canCreate) return true
    return false
  })()

  // Handle click
  const handleClick = useCallback(() => {
    if (isLeaf && node.knowledgeBase) {
      onSelectKb(node.knowledgeBase)
    } else {
      onToggleExpand(node.id)
    }
  }, [isLeaf, node, onSelectKb, onToggleExpand])

  // Handle group settings for group-item nodes
  const handleGroupSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (node.group && onOpenGroupSettings) {
        onOpenGroupSettings(node.group)
      }
    },
    [node.group, onOpenGroupSettings]
  )

  // Handle KB settings for leaf nodes
  const handleKbSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (node.knowledgeBase && onEditKb) {
        onEditKb(node.knowledgeBase)
      }
    },
    [node.knowledgeBase, onEditKb]
  )

  // Render icon
  const renderIcon = () => {
    if (isLeaf) {
      return getKbIcon(node.icon)
    }
    if (node.type === 'category-root') {
      return getCategoryIcon(node.icon)
    }
    if (node.type === 'group-item') {
      return <Users className="w-3.5 h-3.5 text-text-secondary" />
    }
    return getSubCategoryIcon(node.id)
  }

  // Translate label for category nodes (labels stored as i18n keys)
  const displayLabel = (() => {
    if (node.type === 'category-root' || node.type === 'category-sub') {
      return t(node.label)
    }
    return node.label
  })()

  return (
    <div>
      <div
        className={`
          group flex items-center gap-1.5 py-1.5 pr-2 cursor-pointer transition-colors text-sm
          ${isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-text-primary'}
          ${node.type === 'category-root' ? 'font-medium' : ''}
        `}
        style={{ paddingLeft: `${paddingLeft}px` }}
        onClick={handleClick}
        data-testid={
          isLeaf ? `knowledge-tree-kb-${node.knowledgeBase?.id}` : `knowledge-tree-node-${node.id}`
        }
      >
        {/* Expand/collapse arrow (non-leaf only) */}
        {!isLeaf ? (
          <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
            {node.loading ? (
              <Spinner size="sm" />
            ) : isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </span>
        ) : (
          <span className="flex-shrink-0 w-4" />
        )}

        {/* Icon */}
        <span className="flex-shrink-0">{renderIcon()}</span>

        {/* Label */}
        <span className="flex-1 truncate text-xs">{displayLabel}</span>

        {/* Doc count for leaf nodes */}
        {isLeaf && node.docCount !== undefined && (
          <span className="flex-shrink-0 text-[10px] text-text-muted tabular-nums">
            {node.docCount}
          </span>
        )}

        {/* Actions (visible on hover) */}
        <span className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Create KB button */}
          {showCreate && (
            <CreateKbButton
              scope={node.scope || 'personal'}
              groupName={node.groupName}
              onCreateKb={onCreateKb}
            />
          )}

          {/* Group settings button for group nodes */}
          {node.type === 'group-item' &&
            node.group &&
            onOpenGroupSettings &&
            canManageGroup?.(node.group) && (
              <button
                className="p-0.5 rounded hover:bg-muted text-text-muted hover:text-primary transition-colors"
                onClick={handleGroupSettings}
                title={t('document.groupSettings')}
                data-testid={`group-settings-${node.group.id}`}
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            )}

          {/* KB settings button for notebook leaf nodes */}
          {isLeaf && node.knowledgeBase && onEditKb && canManageKb?.(node.knowledgeBase) && (
            <button
              className="p-0.5 rounded hover:bg-muted text-text-muted hover:text-primary transition-colors"
              onClick={handleKbSettings}
              title={t('document.knowledgeBase.edit')}
              data-testid={`kb-settings-${node.knowledgeBase.id}`}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {node.children!.map(child => {
            // For group-item nodes: KB leaves should align with the parent group (same depth)
            // Child groups should be indented (depth + 1)
            const childDepth =
              node.type === 'group-item' && child.type === 'kb-leaf' ? depth : depth + 1
            return (
              <TreeNodeItem
                key={child.id}
                node={child}
                depth={childDepth}
                selectedKbId={selectedKbId}
                expandState={expandState}
                searchQuery={searchQuery}
                onToggleExpand={onToggleExpand}
                onSelectKb={onSelectKb}
                onCreateKb={onCreateKb}
                onOpenGroupSettings={onOpenGroupSettings}
                onEditKb={onEditKb}
                canManageGroup={canManageGroup}
                canManageKb={canManageKb}
              />
            )
          })}
        </div>
      )}

      {/* Loading indicator for group nodes */}
      {isExpanded && node.loading && (
        <div
          className="flex items-center justify-center py-2"
          style={{ paddingLeft: `${paddingLeft + 20}px` }}
        >
          <Spinner className="w-3 h-3" />
          <span className="ml-2 text-xs text-text-muted">{t('document.tree.loadingKbs')}</span>
        </div>
      )}
    </div>
  )
}
