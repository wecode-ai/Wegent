// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingtalkDocTreeView - Full document tree view for DingTalk documents.
 *
 * Renders the complete document tree with folders (collapsible) and documents
 * (clickable links), replacing the split folder-tree + flat-list layout.
 */

'use client'

import { useState, useCallback } from 'react'
import type { MouseEvent, KeyboardEvent } from 'react'
import { Folder, FolderOpen, ChevronRight, ChevronDown, FileText, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

interface DingtalkDocTreeViewProps {
  nodes: DingtalkDocNode[]
}

/** Get icon for a document node based on its type */
function NodeIcon({ nodeType, isOpen }: { nodeType: string; isOpen?: boolean }) {
  if (nodeType === 'folder') {
    return isOpen ? (
      <FolderOpen className="w-4 h-4 flex-shrink-0 text-primary" />
    ) : (
      <Folder className="w-4 h-4 flex-shrink-0 text-text-secondary" />
    )
  }
  return <FileText className="w-4 h-4 flex-shrink-0 text-primary" />
}

/** Convert ISO date string to millisecond timestamp for formatDateTime */
function isoToMs(dateStr: string): number | undefined {
  if (!dateStr) return undefined
  const ms = new Date(dateStr).getTime()
  return isNaN(ms) ? undefined : ms
}

/** Single tree node (folder or document) */
function TreeViewNode({ node, level }: { node: DingtalkDocNode; level: number }) {
  const { t } = useTranslation('knowledge')
  const isFolder = node.node_type === 'folder'
  const hasChildren = isFolder && node.children && node.children.length > 0
  const [isExpanded, setIsExpanded] = useState(level === 0)

  const handleToggle = useCallback(
    (e: MouseEvent) => {
      if (isFolder) {
        e.preventDefault()
        setIsExpanded(prev => !prev)
      }
    },
    [isFolder]
  )

  const handleToggleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isFolder && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        setIsExpanded(prev => !prev)
      }
    },
    [isFolder]
  )

  const indentPx = level * 20 + 8

  if (isFolder) {
    return (
      <div>
        <button
          type="button"
          onClick={handleToggle}
          onKeyDown={handleToggleKeyDown}
          className={cn(
            'w-full flex items-center gap-1.5 py-2 min-h-[44px] rounded-md text-sm transition-colors',
            'hover:bg-surface-hover text-text-primary'
          )}
          style={{ paddingLeft: `${indentPx}px`, paddingRight: '8px' }}
          aria-expanded={isExpanded}
          data-testid={`dingtalk-tree-folder-${node.dingtalk_node_id}`}
        >
          {/* Expand/collapse chevron */}
          <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
              )
            ) : null}
          </span>

          {/* Folder icon */}
          <NodeIcon nodeType={node.node_type} isOpen={isExpanded} />

          {/* Folder name */}
          <span className="flex-1 text-left truncate font-medium">{node.name}</span>

          {/* Child count badge */}
          {hasChildren && (
            <span className="text-xs text-text-muted flex-shrink-0">{node.children!.length}</span>
          )}
        </button>

        {/* Children */}
        {hasChildren && isExpanded && (
          <div>
            {node.children!.map(child => (
              <TreeViewNode key={child.dingtalk_node_id} node={child} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Document / file node - two-line layout: name on top, updated time below
  const updatedTime = formatDateTime(isoToMs(node.content_updated_at))

  // Validate doc_url to only allow safe protocols (http/https)
  const safeDocUrl = (() => {
    if (!node.doc_url) return null
    try {
      const parsed = new URL(node.doc_url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return node.doc_url
      }
      return null
    } catch {
      return null
    }
  })()

  const nodeContent = (
    <>
      {/* First row: icon + name + external link */}
      <div className="flex items-center gap-1.5">
        {/* Indent spacer */}
        <span className="flex-shrink-0 w-4 h-4" />
        <NodeIcon nodeType={node.node_type} />
        <span className="flex-1 truncate hover:text-primary hover:underline">{node.name}</span>
        {safeDocUrl && (
          <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </div>
      {/* Second row: last modified time */}
      {updatedTime && (
        <div className="text-xs text-text-muted mt-0.5" style={{ paddingLeft: '38px' }}>
          {t('document.dingtalk.lastModified', 'Last modified')}: {updatedTime}
        </div>
      )}
    </>
  )

  if (safeDocUrl) {
    return (
      <a
        href={safeDocUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'w-full py-1.5 px-2 rounded-md text-sm transition-colors block',
          'hover:bg-surface-hover text-text-primary group'
        )}
        style={{ paddingLeft: `${indentPx}px`, paddingRight: '8px' }}
        data-testid={`dingtalk-tree-doc-${node.dingtalk_node_id}`}
      >
        {nodeContent}
      </a>
    )
  }

  return (
    <div
      className={cn('w-full py-1.5 px-2 rounded-md text-sm block', 'text-text-primary')}
      style={{ paddingLeft: `${indentPx}px`, paddingRight: '8px' }}
      data-testid={`dingtalk-tree-doc-${node.dingtalk_node_id}`}
    >
      {nodeContent}
    </div>
  )
}

export function DingtalkDocTreeView({ nodes }: DingtalkDocTreeViewProps) {
  if (nodes.length === 0) {
    return null
  }

  return (
    <div className="space-y-0.5 p-2" data-testid="dingtalk-doc-tree-view">
      {nodes.map(node => (
        <TreeViewNode key={node.dingtalk_node_id} node={node} level={0} />
      ))}
    </div>
  )
}
