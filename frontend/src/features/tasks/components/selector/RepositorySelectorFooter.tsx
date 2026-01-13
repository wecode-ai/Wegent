// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { RefreshCw } from 'lucide-react'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { RepositorySelectorFooterProps } from './types'

/**
 * Shared footer component for RepositorySelector
 * Contains configure integration link and refresh button
 */
export function RepositorySelectorFooter({
  onConfigureClick,
  onRefreshClick,
  isRefreshing,
}: RepositorySelectorFooterProps) {
  const { t } = useTranslation()

  const handleKeyDown = (e: React.KeyboardEvent, onClick: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div className="border-t border-border bg-base flex items-center justify-between px-2.5 py-2 text-xs text-text-secondary">
      <div
        className="cursor-pointer group flex items-center space-x-2 hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1 py-0.5"
        onClick={onConfigureClick}
        role="button"
        tabIndex={0}
        onKeyDown={e => handleKeyDown(e, onConfigureClick)}
      >
        <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
        <span className="font-medium group-hover:text-text-primary">
          {t('branches.configure_integration')}
        </span>
      </div>
      <div
        className="cursor-pointer flex items-center gap-1.5 hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1.5 py-0.5"
        onClick={e => {
          e.stopPropagation()
          onRefreshClick()
        }}
        role="button"
        tabIndex={0}
        title={t('branches.load_more')}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onRefreshClick()
          }
        }}
      >
        <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
        <span className="text-xs">
          {isRefreshing ? t('branches.refreshing') : t('actions.refresh')}
        </span>
      </div>
    </div>
  )
}
