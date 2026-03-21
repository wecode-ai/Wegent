// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeTreePanel wraps the KnowledgeTree with collapse/expand behavior.
 *
 * - Initially shows as a sidebar (280px width)
 * - When a KB is selected, the tree stays open until mouse leaves the panel
 * - Mouse leaving the panel area triggers collapse with animation
 */

'use client'

import { useCallback, useState, useRef, useEffect } from 'react'
import { PanelLeftClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KnowledgeTree } from './KnowledgeTree'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
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
  /** Open group settings handler */
  onOpenGroupSettings?: (group: Group) => void
  /** Edit knowledge base handler */
  onEditKb?: (kb: KnowledgeBase) => void
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
  onOpenGroupSettings,
  onEditKb,
  isAdmin,
  isCollapsed,
  onCollapsedChange,
}: KnowledgeTreePanelProps) {
  const { t } = useTranslation('knowledge')
  // Track if a KB was just selected (pending collapse on mouse leave)
  const [pendingCollapse, setPendingCollapse] = useState(false)
  const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  // Track animation state: 'expanded' | 'collapsing' | 'collapsed' | 'expanding'
  const [animationState, setAnimationState] = useState<
    'expanded' | 'collapsing' | 'collapsed' | 'expanding'
  >(isCollapsed ? 'collapsed' : 'expanded')

  // Sync animation state with isCollapsed prop
  useEffect(() => {
    if (isCollapsed && animationState === 'expanded') {
      // Start collapse animation
      setAnimationState('collapsing')
    } else if (!isCollapsed && animationState === 'collapsed') {
      // Start expand animation - first render with w-0, then animate to w-72
      setAnimationState('expanding')
      // Use requestAnimationFrame to ensure the initial state is rendered before animating
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimationState('expanded')
        })
      })
    }
  }, [isCollapsed, animationState])

  // Handle animation end
  const handleTransitionEnd = useCallback(() => {
    if (animationState === 'collapsing') {
      setAnimationState('collapsed')
    }
  }, [animationState])

  // Handle KB selection in tree sidebar - mark for collapse on mouse leave
  const handleSelectKbInTree = useCallback(
    (kb: KnowledgeBase) => {
      onSelectKb(kb)
      // Mark that we should collapse when mouse leaves
      setPendingCollapse(true)
    },
    [onSelectKb]
  )

  // Handle collapse button click
  const handleCollapse = useCallback(() => {
    setPendingCollapse(false)
    onCollapsedChange(true)
  }, [onCollapsedChange])

  // Handle mouse leave - collapse if a KB was selected
  const handleMouseLeave = useCallback(() => {
    if (pendingCollapse) {
      // Add a small delay to prevent accidental collapse
      collapseTimeoutRef.current = setTimeout(() => {
        setPendingCollapse(false)
        onCollapsedChange(true)
      }, 150)
    }
  }, [pendingCollapse, onCollapsedChange])

  // Handle mouse enter - cancel pending collapse
  const handleMouseEnter = useCallback(() => {
    if (collapseTimeoutRef.current) {
      clearTimeout(collapseTimeoutRef.current)
      collapseTimeoutRef.current = null
    }
  }, [])

  // Fully collapsed state: render nothing
  if (animationState === 'collapsed') {
    return null
  }

  // Determine width and opacity based on animation state
  const isCollapsedOrExpanding = animationState === 'collapsing' || animationState === 'expanding'

  // Expanded, expanding, or collapsing state: render with animation
  return (
    <div
      className={cn(
        'flex-shrink-0 h-full border-r border-border bg-base flex flex-col overflow-hidden transition-all duration-200 ease-out',
        isCollapsedOrExpanding ? 'w-0 opacity-0 border-r-0' : 'w-72 opacity-100'
      )}
      data-testid="knowledge-tree-sidebar"
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      onTransitionEnd={handleTransitionEnd}
    >
      {/* Header with collapse button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium text-text-primary">{t('document.tree.title')}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleCollapse}
          title={t('document.tree.collapse')}
          data-testid="collapse-tree-button"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-hidden">
        <KnowledgeTree
          nodes={nodes}
          selectedKbId={selectedKbId}
          loading={loading}
          expandState={expandState}
          onToggleExpand={onToggleExpand}
          onSelectKb={handleSelectKbInTree}
          onCreateKb={onCreateKb}
          onOpenGroupSettings={onOpenGroupSettings}
          onEditKb={onEditKb}
          isAdmin={isAdmin}
        />
      </div>
    </div>
  )
}
