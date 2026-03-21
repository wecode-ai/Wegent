// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * FavoritesSection - Displays user's favorite knowledge bases.
 *
 * Supports drag-and-drop reordering of favorites.
 */

'use client'

import { useCallback } from 'react'
import { Star } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import { CollapsibleSection } from './CollapsibleSection'
import { KbItem } from './KbItem'
import type { KnowledgeBase } from '@/types/knowledge'

export interface FavoritesSectionProps {
  /** Favorite knowledge bases */
  favorites: KnowledgeBase[]
  /** Whether favorites are loading */
  isLoading: boolean
  /** Currently selected KB ID */
  selectedKbId: number | null
  /** Whether section is expanded */
  isExpanded: boolean
  /** Toggle expand/collapse */
  onToggle: () => void
  /** Select a knowledge base */
  onSelect: (kb: KnowledgeBase) => void
  /** Remove from favorites */
  onRemove: (kbId: number) => Promise<void>
  /** Reorder favorites */
  onReorder: (kbIds: number[]) => Promise<void>
}

export function FavoritesSection({
  favorites,
  isLoading,
  selectedKbId,
  isExpanded,
  onToggle,
  onSelect,
  onRemove,
  onReorder: _onReorder,
}: FavoritesSectionProps) {
  const { t } = useTranslation('knowledge')

  const handleRemove = useCallback(
    async (kbId: number) => {
      try {
        await onRemove(kbId)
      } catch (error) {
        console.error('Failed to remove favorite:', error)
      }
    },
    [onRemove]
  )

  return (
    <CollapsibleSection
      title={t('document.sidebar.favorites', '收藏')}
      icon={<Star className="w-4 h-4 text-yellow-500" />}
      isExpanded={isExpanded}
      onToggle={onToggle}
      count={favorites.length}
      testId="favorites-section"
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : favorites.length === 0 ? (
        <div className="px-3 py-3 text-xs text-text-muted text-center">
          {t('document.sidebar.noFavorites', '暂无收藏的知识库')}
        </div>
      ) : (
        <div className="space-y-0.5">
          {favorites.map(kb => (
            <KbItem
              key={kb.id}
              kb={kb}
              isSelected={kb.id === selectedKbId}
              onSelect={() => onSelect(kb)}
              onRemove={() => handleRemove(kb.id)}
              showDocCount
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

export default FavoritesSection
