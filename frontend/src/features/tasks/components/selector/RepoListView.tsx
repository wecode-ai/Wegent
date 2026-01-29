// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { Check, FolderGit2, FolderX } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Skeleton } from '@/components/ui/skeleton'
import { RepositorySelectorFooter } from './RepositorySelectorFooter'

/**
 * Repository item for display
 */
export interface RepoItem {
  value: string
  label: string
  searchText: string
}

/**
 * Props for RepoListView component
 */
export interface RepoListViewProps {
  /** List of repositories to display */
  repos: RepoItem[]
  /** Currently selected repository ID */
  selectedRepoId: string | null
  /** Callback when a repository is selected */
  onSelect: (repoId: string) => void
  /** Callback when search value changes */
  onSearchChange: (value: string) => void
  /** Callback when configure button is clicked */
  onConfigureClick: () => void
  /** Callback when refresh button is clicked */
  onRefreshClick: () => void
  /** Callback when clear selection is clicked (to disable workspace requirement) */
  onClearSelection?: () => void
  /** Whether the repository list is loading */
  isLoading: boolean
  /** Whether a search is in progress */
  isSearching: boolean
  /** Whether a refresh is in progress */
  isRefreshing: boolean
  /** Error message to display */
  error: string | null
}

/**
 * RepoListView - Repository list view component
 *
 * Displays a searchable list of repositories with loading states,
 * error handling, and footer actions.
 */
export function RepoListView({
  repos,
  selectedRepoId,
  onSelect,
  onSearchChange,
  onConfigureClick,
  onRefreshClick,
  onClearSelection,
  isLoading,
  isRefreshing,
  error,
}: RepoListViewProps) {
  const { t } = useTranslation()

  return (
    <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden" shouldFilter={false}>
      {/* Header */}
      <div className="flex items-center border-b border-border px-3 py-2">
        <FolderGit2 className="w-4 h-4 text-text-muted mr-2" />
        <span className="text-sm font-medium text-text-primary">
          {t('common:repos.repository')}
        </span>
      </div>

      {/* Search Input */}
      <CommandInput
        placeholder={t('common:branches.search_repository')}
        onValueChange={onSearchChange}
        className={cn(
          'h-9 rounded-none border-b border-border flex-shrink-0',
          'placeholder:text-text-muted text-sm'
        )}
      />

      {/* Repository List */}
      <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
        {error ? (
          <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
        ) : repos.length === 0 ? (
          <CommandEmpty className="py-4 text-center text-sm text-text-muted">
            {isLoading ? (
              <div className="p-2 space-y-2">
                <Skeleton className="h-8 w-full rounded-md" />
                <Skeleton className="h-8 w-3/4 rounded-md" />
              </div>
            ) : (
              t('common:branches.select_repository')
            )}
          </CommandEmpty>
        ) : (
          <>
            <CommandEmpty className="py-4 text-center text-sm text-text-muted">
              {t('common:branches.no_match')}
            </CommandEmpty>
            <CommandGroup>
              {repos.map(item => (
                <CommandItem
                  key={item.value}
                  value={item.searchText || item.label}
                  onSelect={() => onSelect(item.value)}
                  className={cn(
                    'group cursor-pointer select-none',
                    'px-3 py-1.5 text-sm text-text-primary',
                    'rounded-md mx-1 my-[2px]',
                    'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                    'aria-selected:bg-hover',
                    '!flex !flex-row !items-center !gap-3'
                  )}
                >
                  <Check
                    className={cn(
                      'h-3 w-3 shrink-0',
                      selectedRepoId === item.value
                        ? 'opacity-100 text-primary'
                        : 'opacity-0 text-text-muted'
                    )}
                  />
                  <span className="flex-1 min-w-0 truncate" title={item.label}>
                    {item.label}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>

      {/* Footer */}
      <div className="border-t border-border">
        {/* Clear selection button - only show when callback provided */}
        {onClearSelection && (
          <button
            type="button"
            onClick={onClearSelection}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm',
              'text-text-muted hover:text-error hover:bg-error/10',
              'transition-colors font-medium border-dash'
            )}
          >
            <FolderX className="w-4 h-4" />
            <span>{t('common:repos.no_workspace_short', '不使用代码仓库')}</span>
          </button>
        )}
        <RepositorySelectorFooter
          onConfigureClick={onConfigureClick}
          onRefreshClick={onRefreshClick}
          isRefreshing={isRefreshing}
        />
      </div>
    </Command>
  )
}
