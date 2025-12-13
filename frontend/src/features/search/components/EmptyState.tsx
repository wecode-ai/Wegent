// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from 'react-i18next'
import { Search, Command } from 'lucide-react'

interface EmptyStateProps {
  hasQuery: boolean
  query?: string
}

export function EmptyState({ hasQuery, query }: EmptyStateProps) {
  const { t } = useTranslation()

  if (!hasQuery) {
    // No search query - show prompt
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
          <Search className="h-8 w-8 text-text-muted" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">
          {t('search.title')}
        </h3>
        <p className="text-sm text-text-secondary max-w-md">
          {t('search.placeholder')}
        </p>
        <div className="mt-4 flex items-center gap-1 text-xs text-text-muted">
          <kbd className="px-2 py-1 bg-muted rounded text-text-secondary font-mono">
            <Command className="h-3 w-3 inline-block" /> K
          </kbd>
          <span>{t('search.shortcut_hint')}</span>
        </div>
      </div>
    )
  }

  // Has query but no results
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
        <Search className="h-8 w-8 text-text-muted" />
      </div>
      <h3 className="text-lg font-medium text-text-primary mb-2">
        {t('search.no_results')}
      </h3>
      <p className="text-sm text-text-secondary max-w-md">
        {t('search.no_results_hint')}
      </p>
      {query && (
        <p className="mt-2 text-sm text-text-muted">
          {t('search.searched_for', { query })}
        </p>
      )}
    </div>
  )
}
