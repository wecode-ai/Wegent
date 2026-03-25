// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { Check, FolderGit2, FolderX, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Command, CommandInput } from '@/components/ui/command'
import { Skeleton } from '@/components/ui/skeleton'
import { RepositorySelectorFooter } from './RepositorySelectorFooter'

// Initial number of repositories to render for performance
const INITIAL_VISIBLE_COUNT = 50
// Number of repositories to load on each scroll
const LOAD_MORE_COUNT = 50

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
  /** Whether the selector is open - used to reset search when reopened */
  isOpen?: boolean
}

/**
 * RepoListView - Repository list view component
 *
 * Displays a searchable list of repositories with loading states,
 * error handling, and footer actions.
 * Optimized for large repository lists with progressive loading.
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
  isOpen,
}: RepoListViewProps) {
  const { t } = useTranslation()
  const listRef = React.useRef<HTMLDivElement>(null)
  // Track visible count for progressive loading
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_COUNT)
  // Track previous isOpen state to detect when selector is reopened
  const prevIsOpenRef = React.useRef(isOpen)

  // Reset search when selector is reopened
  React.useEffect(() => {
    // Detect transition from closed to open
    if (isOpen && !prevIsOpenRef.current) {
      // Reset visible count
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      // Scroll to top
      if (listRef.current) {
        listRef.current.scrollTop = 0
      }
    }
    prevIsOpenRef.current = isOpen
  }, [isOpen])

  // Reset visible count when repos change (new search results)
  // Use a ref to track if this is a new search/filter operation
  const prevReposRef = React.useRef(repos)
  React.useEffect(() => {
    // Check if repos array actually changed (different references or different items)
    const prevRepos = prevReposRef.current
    const hasChanged =
      prevRepos.length !== repos.length ||
      (repos.length > 0 && prevRepos.length > 0 && prevRepos[0]?.value !== repos[0]?.value)

    if (hasChanged) {
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      prevReposRef.current = repos
    }
  }, [repos])

  // Get visible repos based on current count
  const visibleRepos = React.useMemo(() => {
    return repos.slice(0, visibleCount)
  }, [repos, visibleCount])

  const hasMoreRepos = repos.length > visibleCount

  // Handle scroll to load more
  const handleScroll = React.useCallback(() => {
    if (!listRef.current || !hasMoreRepos) return

    const { scrollTop, scrollHeight, clientHeight } = listRef.current
    // Load more when user scrolls to bottom (within 50px)
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      setVisibleCount(prev => Math.min(prev + LOAD_MORE_COUNT, repos.length))
    }
  }, [hasMoreRepos, repos.length])

  return (
    <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden" shouldFilter={false}>
      {/* Header */}
      <div className="flex items-center border-b border-border px-3 py-2">
        <FolderGit2 className="w-4 h-4 text-text-muted mr-2" />
        <span className="text-sm font-medium text-text-primary">
          {t('common:repos.repository')}
        </span>
        <span className="ml-auto text-xs text-text-muted">
          {repos.length > 0 && `${Math.min(visibleCount, repos.length)} / ${repos.length}`}
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

      {/* Repository List - Wrapped in scrollable div for performance */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1"
      >
        {error ? (
          <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
        ) : repos.length === 0 ? (
          <div className="py-4 text-center text-sm text-text-muted">
            {isLoading ? (
              <div className="p-2 space-y-2">
                <Skeleton className="h-8 w-full rounded-md" />
                <Skeleton className="h-8 w-3/4 rounded-md" />
              </div>
            ) : (
              t('common:branches.select_repository')
            )}
          </div>
        ) : (
          <>
            <div className="py-4 text-center text-sm text-text-muted hidden data-[empty=true]:block">
              {t('common:branches.no_match')}
            </div>
            <div role="list" className="p-1">
              {visibleRepos.map(item => (
                <div
                  key={item.value}
                  role="listitem"
                  onClick={() => onSelect(item.value)}
                  data-testid={`repo-option-${item.label.replace(/\//g, '-')}`}
                  className={cn(
                    'group cursor-pointer select-none',
                    'px-3 py-1.5 text-sm text-text-primary',
                    'rounded-md mx-1 my-[2px]',
                    'hover:bg-hover',
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
                </div>
              ))}
            </div>
            {/* Load more indicator */}
            {hasMoreRepos && (
              <div className="py-2 px-3 text-center text-xs text-text-muted">
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{t('common:repos.scroll_to_load_more', 'Scroll to load more...')}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

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
