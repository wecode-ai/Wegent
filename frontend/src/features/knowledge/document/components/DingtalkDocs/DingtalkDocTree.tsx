// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingtalkDocTree - Folder tree component for DingTalk documents.
 *
 * Renders a collapsible tree of folders for navigation.
 */

'use client'

import { useState, useCallback } from 'react'
import { Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

interface DingtalkDocTreeProps {
  nodes: DingtalkDocNode[]
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
}

function TreeNode({
  node,
  level,
  selectedFolderId,
  onSelectFolder,
}: {
  node: DingtalkDocNode
  level: number
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
}) {
  const isFolder = node.node_type === 'folder'
  const isSelected = selectedFolderId === node.dingtalk_node_id
  const [isExpanded, setIsExpanded] = useState(level === 0)

  const handleClick = useCallback(() => {
    if (isFolder) {
      onSelectFolder(node.dingtalk_node_id)
    }
  }, [isFolder, node.dingtalk_node_id, onSelectFolder])

  const handleToggle = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    setIsExpanded(prev => !prev)
  }, [])

  const handleToggleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleToggle(e)
      }
    },
    [handleToggle]
  )

  // Only render folders in the tree (docs shown in list)
  if (!isFolder) return null

  const hasChildren = node.children && node.children.length > 0

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'w-full flex items-center gap-1.5 py-1.5 rounded-md text-sm transition-colors',
          'hover:bg-surface-hover',
          isSelected && 'bg-primary/10 text-primary font-medium'
        )}
        style={{ paddingLeft: `${level * 16 + 8}px`, paddingRight: '8px' }}
        data-testid={`dingtalk-folder-${node.dingtalk_node_id}`}
      >
        {/* Expand toggle */}
        {hasChildren ? (
          <button
            type="button"
            role="button"
            tabIndex={0}
            aria-expanded={isExpanded}
            aria-controls={`dingtalk-tree-children-${node.dingtalk_node_id}`}
            className="flex-shrink-0 h-11 min-w-[44px] flex items-center justify-center cursor-pointer hover:bg-muted rounded"
            onClick={handleToggle}
            onKeyDown={handleToggleKeyDown}
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        ) : (
          <span className="flex-shrink-0 w-4 h-4" />
        )}

        {/* Icon */}
        {isSelected ? (
          <FolderOpen className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
        ) : (
          <Folder className="w-3.5 h-3.5 flex-shrink-0 text-text-secondary" />
        )}

        {/* Name */}
        <span className="flex-1 text-left truncate">{node.name}</span>
      </button>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div id={`dingtalk-tree-children-${node.dingtalk_node_id}`} className="mt-0.5">
          {node.children!.map(child => (
            <TreeNode
              key={child.dingtalk_node_id}
              node={child}
              level={level + 1}
              selectedFolderId={selectedFolderId}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DingtalkDocTree({ nodes, selectedFolderId, onSelectFolder }: DingtalkDocTreeProps) {
  const { t } = useTranslation('knowledge')

  return (
    <div className="space-y-0.5" data-testid="dingtalk-doc-tree">
      {/* Root / All items */}
      <button
        type="button"
        onClick={() => onSelectFolder(null)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors',
          'hover:bg-surface-hover',
          selectedFolderId === null && 'bg-primary/10 text-primary font-medium'
        )}
        data-testid="dingtalk-folder-root"
      >
        <span className="flex-shrink-0 w-4 h-4" />
        <Folder className="w-3.5 h-3.5 flex-shrink-0 text-text-secondary" />
        <span className="flex-1 text-left truncate">
          {t('document.dingtalk.allDocs', '全部文档')}
        </span>
      </button>

      {/* Folder tree */}
      {nodes.map(node => (
        <TreeNode
          key={node.dingtalk_node_id}
          node={node}
          level={0}
          selectedFolderId={selectedFolderId}
          onSelectFolder={onSelectFolder}
        />
      ))}
    </div>
  )
}
