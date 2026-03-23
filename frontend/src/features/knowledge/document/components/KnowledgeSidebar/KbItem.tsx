// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KbItem - A single knowledge base item in the sidebar.
 *
 * Displays KB name, icon, and optional actions.
 */

'use client'

import { BookOpen, Database, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { KnowledgeBase } from '@/types/knowledge'

export interface KbItemProps {
  /** Knowledge base data */
  kb: KnowledgeBase
  /** Whether this item is selected */
  isSelected: boolean
  /** Click handler */
  onSelect: () => void
  /** Optional remove handler (for favorites) */
  onRemove?: () => void
  /** Optional secondary text (e.g., time ago) */
  secondaryText?: string
  /** Whether to show document count */
  showDocCount?: boolean
}

export function KbItem({
  kb,
  isSelected,
  onSelect,
  onRemove,
  secondaryText,
  showDocCount = false,
}: KbItemProps) {
  const isClassic = kb.kb_type === 'classic'

  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors text-sm',
        isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-text-primary'
      )}
      onClick={onSelect}
      data-testid={`kb-item-${kb.id}`}
    >
      {/* Icon */}
      <span className="flex-shrink-0">
        {isClassic ? (
          <Database className="w-3.5 h-3.5 text-text-secondary" />
        ) : (
          <BookOpen className="w-3.5 h-3.5 text-primary" />
        )}
      </span>

      {/* Name */}
      <span className="flex-1 truncate text-sm">{kb.name}</span>

      {/* Secondary text (e.g., time ago) */}
      {secondaryText && (
        <span className="flex-shrink-0 text-[10px] text-text-muted">{secondaryText}</span>
      )}

      {/* Document count */}
      {showDocCount && kb.document_count !== undefined && (
        <span className="flex-shrink-0 text-[10px] text-text-muted tabular-nums">
          {kb.document_count}
        </span>
      )}

      {/* Remove button (for favorites) */}
      {onRemove && (
        <button
          className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 
                     hover:bg-muted text-text-muted hover:text-text-primary transition-all"
          onClick={e => {
            e.stopPropagation()
            onRemove()
          }}
          title="移除"
          data-testid={`kb-item-remove-${kb.id}`}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

export default KbItem
