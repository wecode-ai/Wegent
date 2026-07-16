// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Fragment } from 'react'
import { ChevronRight, Home } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { BreadcrumbItem } from '../hooks/useFolderNavigation'

interface KnowledgeFolderBreadcrumbProps {
  breadcrumbs: BreadcrumbItem[]
  onNavigate: (folderId: number | null) => void
}

// Collapse middle items when path depth exceeds this threshold
const MAX_VISIBLE_SEGMENTS = 4

export function KnowledgeFolderBreadcrumb({
  breadcrumbs,
  onNavigate,
}: KnowledgeFolderBreadcrumbProps) {
  const { t } = useTranslation('knowledge')
  // Root item name is translated here, not in the data hook
  const rootLabel = t('document.nav.allDocuments')
  const shouldCollapse = breadcrumbs.length > MAX_VISIBLE_SEGMENTS + 1

  const visibleBreadcrumbs: BreadcrumbItem[] = shouldCollapse
    ? [breadcrumbs[0], { id: -1, name: '...' }, ...breadcrumbs.slice(-(MAX_VISIBLE_SEGMENTS - 1))]
    : breadcrumbs

  return (
    <nav
      className="flex items-center gap-1 px-4 h-11 md:h-9 border-b border-border bg-surface/50 overflow-hidden"
      aria-label="folder navigation breadcrumb"
    >
      {visibleBreadcrumbs.map((item, index) => {
        const isLast = index === visibleBreadcrumbs.length - 1
        const isEllipsis = item.id === -1

        return (
          <Fragment key={item.id ?? 'root'}>
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />}
            {isEllipsis ? (
              <span className="text-xs text-text-muted px-1 select-none">...</span>
            ) : isLast ? (
              <span className="flex items-center gap-1 text-sm font-medium text-text-primary truncate max-w-[200px]">
                {index === 0 && <Home className="h-3.5 w-3.5 flex-shrink-0" />}
                <span className="truncate">{index === 0 ? rootLabel : item.name}</span>
              </span>
            ) : (
              <button
                onClick={() => onNavigate(item.id)}
                className="flex items-center gap-1 text-sm text-text-secondary hover:text-primary truncate max-w-[150px] transition-colors min-h-[44px] md:min-h-0"
                data-testid={`breadcrumb-${item.id ?? 'root'}`}
              >
                {index === 0 && <Home className="h-3.5 w-3.5 flex-shrink-0" />}
                {index > 0 && <span className="truncate">{item.name}</span>}
              </button>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
