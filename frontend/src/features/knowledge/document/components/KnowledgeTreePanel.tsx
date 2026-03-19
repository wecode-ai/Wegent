// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeTreePanel wraps the KnowledgeTree with collapse/expand/popover behavior.
 *
 * - Initially shows as a sidebar (280px width)
 * - When a KB is selected, collapses to a narrow strip (44px)
 * - Clicking the narrow strip opens a popover overlay showing the tree
 * - Selecting a different KB in the popover closes it and updates the selection
 */

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { PanelLeft } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { KnowledgeTree } from './KnowledgeTree'
import type { TreeNode } from '../hooks/useKnowledgeTree'
import type { KnowledgeBase, KnowledgeBaseType } from '@/types/knowledge'
import type { Group } from '@/types/group'

interface KnowledgeTreePanelProps {
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
  /** Create group chat handler */
  onCreateGroupChat?: (
    group: Group,
    kbInfo?: { name: string; namespace: string },
    allKbs?: KnowledgeBase[]
  ) => void
  /** Whether user is admin */
  isAdmin: boolean
  /** Whether tree should be collapsed (when a KB is selected) */
  isCollapsed: boolean
  /** Callback when collapsed state changes */
  onCollapsedChange: (collapsed: boolean) => void
}

export function KnowledgeTreePanel({
  nodes,
  selectedKbId,
  loading,
  expandState,
  onToggleExpand,
  onSelectKb,
  onCreateKb,
  onCreateGroupChat,
  isAdmin,
  isCollapsed,
  onCollapsedChange,
}: KnowledgeTreePanelProps) {
  const { t } = useTranslation('knowledge')
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Close popover when clicking outside
  useEffect(() => {
    if (!isPopoverOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsPopoverOpen(false)
      }
    }

    // Use setTimeout to avoid immediate close from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isPopoverOpen])

  // Close popover on Escape
  useEffect(() => {
    if (!isPopoverOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPopoverOpen(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isPopoverOpen])

  // Handle KB selection in popover - close popover after selection
  const handleSelectKbInPopover = useCallback(
    (kb: KnowledgeBase) => {
      onSelectKb(kb)
      setIsPopoverOpen(false)
    },
    [onSelectKb]
  )

  // Handle KB selection in tree sidebar - collapse after selection
  const handleSelectKbInTree = useCallback(
    (kb: KnowledgeBase) => {
      onSelectKb(kb)
      onCollapsedChange(true)
    },
    [onSelectKb, onCollapsedChange]
  )

  // Collapsed state: narrow strip with expand button
  if (isCollapsed) {
    return (
      <div className="relative flex-shrink-0">
        {/* Narrow collapsed strip */}
        <div
          className="w-11 h-full border-r border-border bg-base flex flex-col items-center pt-3"
          data-testid="knowledge-tree-collapsed"
        >
          <button
            ref={triggerRef}
            className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-muted text-text-secondary hover:text-primary transition-colors"
            onClick={() => setIsPopoverOpen(!isPopoverOpen)}
            title={t('document.tree.expandTree')}
            data-testid="knowledge-tree-expand-button"
          >
            <PanelLeft className="w-5 h-5" />
          </button>
        </div>

        {/* Popover overlay */}
        {isPopoverOpen && (
          <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40" onClick={() => setIsPopoverOpen(false)} />

            {/* Popover panel */}
            <div
              ref={popoverRef}
              className="absolute left-11 top-0 z-50 w-72 h-full bg-base border-r border-border shadow-lg animate-in slide-in-from-left-2 duration-200"
              data-testid="knowledge-tree-popover"
            >
              <KnowledgeTree
                nodes={nodes}
                selectedKbId={selectedKbId}
                loading={loading}
                expandState={expandState}
                onToggleExpand={onToggleExpand}
                onSelectKb={handleSelectKbInPopover}
                onCreateKb={onCreateKb}
                onCreateGroupChat={onCreateGroupChat}
                isAdmin={isAdmin}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  // Expanded state: full tree sidebar
  return (
    <div
      className="flex-shrink-0 w-72 h-full border-r border-border bg-base"
      data-testid="knowledge-tree-sidebar"
    >
      <KnowledgeTree
        nodes={nodes}
        selectedKbId={selectedKbId}
        loading={loading}
        expandState={expandState}
        onToggleExpand={onToggleExpand}
        onSelectKb={handleSelectKbInTree}
        onCreateKb={onCreateKb}
        onCreateGroupChat={onCreateGroupChat}
        isAdmin={isAdmin}
      />
    </div>
  )
}
