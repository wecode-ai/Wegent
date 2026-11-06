// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KbItem - A single knowledge base item in the sidebar.
 *
 * Displays KB name, icon, and optional actions.
 */

'use client'

import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { KnowledgeBaseIcon } from '../KnowledgeBaseIcon'
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
  const { t } = useTranslation('knowledge')
  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-3 cursor-pointer transition-colors text-sm',
        isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-text-primary'
      )}
    >
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left md:min-h-8"
        onClick={onSelect}
        data-testid={`kb-item-${kb.id}`}
      >
        {/* Icon */}
        <span className="flex-shrink-0">
          <KnowledgeBaseIcon kbType={kb.kb_type} />
        </span>

        {/* Name. Titled because it truncates: a code wiki is named after its
          repository, which is routinely longer than a narrow sidebar. */}
        <span className="flex-1 truncate text-sm" title={kb.name}>
          {kb.name}
        </span>

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
      </button>
      {/* Remove button (for favorites) */}
      {onRemove && (
        <button
          className="min-h-11 min-w-11 md:min-h-8 md:min-w-8 flex-shrink-0 rounded md:opacity-0 group-hover:opacity-100
                     hover:bg-muted text-text-muted hover:text-text-primary transition-all"
          onClick={e => {
            e.stopPropagation()
            onRemove()
          }}
          title={t('document.table.delete')}
          data-testid={`kb-item-remove-${kb.id}`}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

export default KbItem
