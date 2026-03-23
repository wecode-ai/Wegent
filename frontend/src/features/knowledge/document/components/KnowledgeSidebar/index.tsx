// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeSidebar - Main sidebar component for knowledge navigation.
 *
 * Provides a hybrid navigation mode with:
 * - Search trigger (Cmd+K)
 * - Favorites section
 * - Recent access section
 * - Navigation section (All + Groups)
 */

'use client'

import { useState, useCallback } from 'react'
import { PanelLeftClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { SearchTrigger } from './SearchTrigger'
import { FavoritesSection as _FavoritesSection } from './FavoritesSection'
import { RecentSection } from './RecentSection'
import { NavigationSection, type KnowledgeGroup } from './NavigationSection'
import { CommandPalette } from '../CommandPalette'
import type { KnowledgeBase } from '@/types/knowledge'
import type { ViewMode } from '../../hooks/useKnowledgeSidebar'

// Re-export KnowledgeGroup type
export type { KnowledgeGroup }

export interface KnowledgeSidebarProps {
  /** Favorite knowledge bases */
  favorites: KnowledgeBase[]
  /** Whether favorites are loading */
  isFavoritesLoading: boolean
  /** Add to favorites */
  onAddFavorite: (kbId: number) => Promise<void>
  /** Remove from favorites */
  onRemoveFavorite: (kbId: number) => Promise<void>
  /** Reorder favorites */
  onReorderFavorites: (kbIds: number[]) => Promise<void>
  /** Recent access items */
  recentItems: KnowledgeBase[]
  /** Clear recent access */
  onClearRecent: () => void
  /** Knowledge groups */
  groups: KnowledgeGroup[]
  /** Whether groups are loading */
  isGroupsLoading: boolean
  /** Currently selected KB ID */
  selectedKbId: number | null
  /** Currently selected group ID */
  selectedGroupId: string | null
  /** Current view mode */
  viewMode: ViewMode
  /** Select a knowledge base */
  onSelectKb: (kb: KnowledgeBase) => void
  /** Select a group */
  onSelectGroup: (groupId: string) => void
  /** Select "All" */
  onSelectAll: () => void
  /** Whether user is admin */
  isAdmin: boolean
  /** Callback to collapse the sidebar */
  onCollapse?: () => void
}

export function KnowledgeSidebar({
  favorites: _favorites,
  isFavoritesLoading: _isFavoritesLoading,
  onAddFavorite: _onAddFavorite,
  onRemoveFavorite: _onRemoveFavorite,
  onReorderFavorites: _onReorderFavorites,
  recentItems,
  onClearRecent,
  groups,
  isGroupsLoading,
  selectedKbId,
  selectedGroupId,
  viewMode,
  onSelectKb,
  onSelectGroup,
  onSelectAll,
  isAdmin: _isAdmin,
  onCollapse,
}: KnowledgeSidebarProps) {
  const { t } = useTranslation('knowledge')
  const [isSearchOpen, setIsSearchOpen] = useState(false)

  // Section collapse states (persisted in localStorage)
  const [sectionStates, setSectionStates] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('knowledge-sidebar-sections')
      return saved ? JSON.parse(saved) : { favorites: true, recent: true, groups: true }
    } catch {
      return { favorites: true, recent: true, groups: true }
    }
  })

  const toggleSection = useCallback((section: string) => {
    setSectionStates(prev => {
      const next = { ...prev, [section]: !prev[section] }
      try {
        localStorage.setItem('knowledge-sidebar-sections', JSON.stringify(next))
      } catch {
        // Ignore storage errors
      }
      return next
    })
  }, [])

  const handleOpenSearch = useCallback(() => {
    setIsSearchOpen(true)
  }, [])

  const _handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false)
  }, [])

  const handleSearchSelectKb = useCallback(
    (kb: KnowledgeBase) => {
      onSelectKb(kb)
      setIsSearchOpen(false)
    },
    [onSelectKb]
  )

  const handleSearchSelectGroup = useCallback(
    (groupId: string) => {
      onSelectGroup(groupId)
      setIsSearchOpen(false)
    },
    [onSelectGroup]
  )

  return (
    <div
      className="flex flex-col h-full bg-base border-r border-border"
      data-testid="knowledge-sidebar"
    >
      {/* Search trigger with collapse button */}
      <div className="p-3 border-b border-border flex items-center gap-2">
        <div className="flex-1">
          <SearchTrigger onOpen={handleOpenSearch} />
        </div>
        {onCollapse && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCollapse}
            className="h-8 w-8 p-0 flex-shrink-0"
            title={t('document.tree.collapseTree')}
            data-testid="knowledge-sidebar-collapse-button"
          >
            <PanelLeftClose className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {/* Favorites section - temporarily hidden
        <FavoritesSection
          favorites={favorites}
          isLoading={isFavoritesLoading}
          selectedKbId={selectedKbId}
          isExpanded={sectionStates.favorites}
          onToggle={() => toggleSection('favorites')}
          onSelect={onSelectKb}
          onRemove={onRemoveFavorite}
          onReorder={onReorderFavorites}
        />
        */}

        {/* Recent section */}
        <RecentSection
          items={recentItems}
          selectedKbId={selectedKbId}
          isExpanded={sectionStates.recent}
          onToggle={() => toggleSection('recent')}
          onSelect={onSelectKb}
          onClear={onClearRecent}
        />
        {/* Navigation section (Personal + Organization + Groups) */}
        <NavigationSection
          groups={groups}
          isLoading={isGroupsLoading}
          selectedGroupId={selectedGroupId}
          isAllSelected={viewMode === 'all'}
          isExpanded={sectionStates.groups}
          onToggle={() => toggleSection('groups')}
          onSelectAll={onSelectAll}
          onSelectGroup={onSelectGroup}
          totalKbCount={groups.reduce((sum, g) => sum + g.kbCount, 0)}
        />
      </div>

      {/* Command palette for global search */}
      <CommandPalette
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        onSelectKb={handleSearchSelectKb}
        onSelectGroup={handleSearchSelectGroup}
      />
    </div>
  )
}

export default KnowledgeSidebar
