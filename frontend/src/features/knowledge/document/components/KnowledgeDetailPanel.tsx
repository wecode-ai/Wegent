// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeDetailPanel renders the right-side detail area for the selected knowledge base.
 *
 * - When no KB is selected: shows empty state
 * - When a KB is selected: embeds the detail page inline via iframe or navigates to it
 *
 * Since the existing detail pages (KnowledgeBaseChatPageDesktop, KnowledgeBaseClassicPageDesktop)
 * are complex full-page components with their own layout (TopNavigation, TaskSidebar, etc.),
 * we embed them via Next.js router push to the detail route. The knowledge tree layout
 * acts as the navigation hub, and selecting a KB opens its detail page.
 *
 * For the inline view, we render a simplified version: KB header with actions + the core content.
 */

'use client'

import { useRouter } from 'next/navigation'
import { BookOpen, FolderOpen, Library } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeBase } from '@/types/knowledge'

interface KnowledgeDetailPanelProps {
  /** Currently selected knowledge base */
  selectedKb: KnowledgeBase | null
}

export function KnowledgeDetailPanel({ selectedKb }: KnowledgeDetailPanelProps) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()

  // Navigate to the KB detail page when a KB is selected
  // This leverages the existing detail page components
  if (selectedKb) {
    router.push(`/knowledge/document/${selectedKb.id}`)
    return (
      <div className="flex-1 flex items-center justify-center bg-base">
        <div className="text-center text-text-muted">
          <div className="animate-pulse">
            {selectedKb.kb_type === 'classic' ? (
              <FolderOpen className="w-12 h-12 mx-auto mb-3 text-text-muted opacity-50" />
            ) : (
              <BookOpen className="w-12 h-12 mx-auto mb-3 text-primary opacity-50" />
            )}
          </div>
          <p className="text-sm">{selectedKb.name}</p>
        </div>
      </div>
    )
  }

  // Empty state - no KB selected
  return (
    <div
      className="flex-1 flex items-center justify-center bg-base"
      data-testid="knowledge-detail-empty"
    >
      <div className="text-center max-w-sm px-6">
        <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-6">
          <Library className="w-8 h-8 text-text-muted opacity-60" />
        </div>
        <h2 className="text-base font-medium text-text-primary mb-2">
          {t('document.tree.emptyState')}
        </h2>
        <p className="text-sm text-text-muted">{t('document.tree.emptyStateHint')}</p>
      </div>
    </div>
  )
}
