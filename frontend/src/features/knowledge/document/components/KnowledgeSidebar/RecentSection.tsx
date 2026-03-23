// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * RecentSection - Displays recently accessed knowledge bases.
 *
 * Shows the last N accessed knowledge bases with relative time.
 */

'use client'

import { useMemo } from 'react'
import { Clock, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { CollapsibleSection } from './CollapsibleSection'
import { KbItem } from './KbItem'
import type { KnowledgeBase } from '@/types/knowledge'

export interface RecentSectionProps {
  /** Recent access items */
  items: KnowledgeBase[]
  /** Currently selected KB ID */
  selectedKbId: number | null
  /** Whether section is expanded */
  isExpanded: boolean
  /** Toggle expand/collapse */
  onToggle: () => void
  /** Select a knowledge base */
  onSelect: (kb: KnowledgeBase) => void
  /** Clear all recent items */
  onClear: () => void
}

/**
 * Format relative time from timestamp
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) {
    return '刚刚'
  }
  if (minutes < 60) {
    return `${minutes}分钟前`
  }
  if (hours < 24) {
    return `${hours}小时前`
  }
  if (days === 1) {
    return '昨天'
  }
  if (days < 7) {
    return `${days}天前`
  }
  return '一周前'
}

export function RecentSection({
  items,
  selectedKbId,
  isExpanded,
  onToggle,
  onSelect,
  onClear,
}: RecentSectionProps) {
  const { t } = useTranslation('knowledge')

  // Add relative time to items
  const itemsWithTime = useMemo(() => {
    return items.map(item => ({
      kb: item,
      // Use updated_at as access time if available, otherwise use current time
      timeText: formatRelativeTime(
        item.updated_at ? new Date(item.updated_at).getTime() : Date.now()
      ),
    }))
  }, [items])

  const clearButton =
    items.length > 0 ? (
      <button
        className="p-1 rounded hover:bg-muted text-text-muted hover:text-text-primary transition-colors"
        onClick={onClear}
        title={t('document.sidebar.clearRecent', '清除最近访问')}
        data-testid="clear-recent-button"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    ) : undefined

  return (
    <CollapsibleSection
      title={t('document.sidebar.recent', '最近')}
      icon={<Clock className="w-4 h-4 text-text-secondary" />}
      isExpanded={isExpanded}
      onToggle={onToggle}
      count={items.length}
      action={clearButton}
      testId="recent-section"
    >
      {items.length === 0 ? (
        <div className="px-3 py-3 text-xs text-text-muted text-center">
          {t('document.sidebar.noRecent', '暂无最近访问')}
        </div>
      ) : (
        <div className="space-y-0.5">
          {itemsWithTime.map(({ kb, timeText }) => (
            <KbItem
              key={kb.id}
              kb={kb}
              isSelected={kb.id === selectedKbId}
              onSelect={() => onSelect(kb)}
              secondaryText={timeText}
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

export default RecentSection
