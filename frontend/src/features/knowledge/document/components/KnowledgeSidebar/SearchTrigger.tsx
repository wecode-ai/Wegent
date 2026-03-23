// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * SearchTrigger - Button to open the global search command palette.
 *
 * Displays a search input-like button with Cmd+K shortcut hint.
 * Listens for Cmd+K / Ctrl+K keyboard shortcut.
 */

'use client'

import { useEffect } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export interface SearchTriggerProps {
  /** Callback when search should be opened */
  onOpen: () => void
}

export function SearchTrigger({ onOpen }: SearchTriggerProps) {
  const { t } = useTranslation('knowledge')

  // Listen for Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        onOpen()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onOpen])

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-muted 
                 bg-surface rounded-md border border-border hover:border-primary/50
                 transition-colors"
      data-testid="knowledge-search-trigger"
    >
      <Search className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1 text-left truncate">
        {t('document.sidebar.searchPlaceholder', '搜索知识库...')}
      </span>
      <kbd className="hidden sm:inline-flex text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
        ⌘K
      </kbd>
    </button>
  )
}

export default SearchTrigger
