// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { FolderGit2, Check, Loader2 } from 'lucide-react'
import { GitRepoInfo, TaskDetail } from '@/types/api'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput } from '@/components/ui/command'

import { RepositorySelectorFooter } from './RepositorySelectorFooter'
import { useRepositorySearch } from '../../hooks/useRepositorySearch'
import { getRepositoryIdentity } from './repositoryIdentity'

// Initial number of repositories to render for performance
const INITIAL_VISIBLE_COUNT = 50
// Number of repositories to load on each scroll
const LOAD_MORE_COUNT = 50

interface MobileRepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo | null) => void
  disabled: boolean
  selectedTaskDetail?: TaskDetail | null
}

/**
 * Mobile-specific Repository Selector
 * Renders as a full-width clickable row that opens a popover
 * Reuses useRepositorySearch hook for consistent behavior with desktop version
 */
export default function MobileRepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail,
}: MobileRepositorySelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // Track visible count for progressive loading
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)

  // Use the shared repository search hook
  const {
    repos,
    loading,
    isRefreshing,
    error,
    handleSearchChange,
    handleRefreshCache,
    handleChange: baseHandleChange,
    resetSearch,
  } = useRepositorySearch({
    selectedRepo,
    handleRepoChange,
    disabled,
    selectedTaskDetail,
  })

  // Reset visible count when repos change (new search results)
  // Use a ref to track if this is a new search/filter operation
  const prevReposRef = useRef(repos)
  useEffect(() => {
    // Check if repos array actually changed (different references or different items)
    const prevRepos = prevReposRef.current
    const hasChanged =
      prevRepos.length !== repos.length ||
      (repos.length > 0 &&
        prevRepos.length > 0 &&
        prevRepos[0]?.git_repo_id !== repos[0]?.git_repo_id)

    if (hasChanged) {
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      prevReposRef.current = repos
    }
  }, [repos])

  // Wrap handleChange to also close the popover
  const handleChange = (value: string) => {
    baseHandleChange(value)
    setOpen(false)
  }

  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref())
  }

  const selectItems = useMemo(() => {
    // Remove duplicates by repository identity
    const seen = new Set<string>()
    const uniqueRepos = repos.filter(repo => {
      const key = getRepositoryIdentity(repo)
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })

    const items = uniqueRepos.map(repo => ({
      value: getRepositoryIdentity(repo),
      label: repo.git_repo,
    }))

    if (selectedRepo) {
      const selectedRepoIdentity = getRepositoryIdentity(selectedRepo)
      const hasSelected = items.some(item => item.value === selectedRepoIdentity)
      if (!hasSelected) {
        items.unshift({
          value: selectedRepoIdentity,
          label: selectedRepo.git_repo,
        })
      }
    }

    return items
  }, [repos, selectedRepo])

  // Get visible items based on current count
  const visibleItems = useMemo(() => {
    return selectItems.slice(0, visibleCount)
  }, [selectItems, visibleCount])

  const hasMoreItems = selectItems.length > visibleCount

  // Handle scroll to load more
  const handleScroll = useCallback(() => {
    if (!listRef.current || !hasMoreItems) return

    const { scrollTop, scrollHeight, clientHeight } = listRef.current
    // Load more when user scrolls to bottom (within 50px)
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      setVisibleCount(prev => Math.min(prev + LOAD_MORE_COUNT, selectItems.length))
    }
  }, [hasMoreItems, selectItems.length])

  // Handle popover open/close changes
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      // Prevent opening when disabled
      if ((disabled || loading) && newOpen) return
      setOpen(newOpen)
      // Reset search when closing
      if (!newOpen) {
        resetSearch()
      }
    },
    [disabled, loading, resetSearch]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || loading}
          className={cn(
            'w-full flex items-center justify-between px-3 py-2.5',
            'text-left transition-colors',
            'hover:bg-hover active:bg-hover',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            loading && 'animate-pulse'
          )}
        >
          <div className="flex items-center gap-3">
            <FolderGit2 className="h-4 w-4 text-text-muted" />
            <span className="text-sm">仓库</span>
          </div>
          <span className="text-sm text-text-muted truncate max-w-[140px]">
            {selectedRepo?.git_repo || '未选择'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-auto min-w-[280px] max-w-[min(500px,90vw)] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'max-h-[400px] flex flex-col'
        )}
        align="end"
        side="top"
        sideOffset={4}
      >
        <Command
          className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden"
          shouldFilter={false}
        >
          <CommandInput
            placeholder={t('branches.search_repository')}
            onValueChange={handleSearchChange}
            className="h-9 rounded-none border-b border-border flex-shrink-0 placeholder:text-text-muted text-sm"
          />
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1"
          >
            {error ? (
              <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
            ) : selectItems.length === 0 ? (
              <div className="py-4 text-center text-sm text-text-muted">
                {loading ? 'Loading...' : t('branches.select_repository')}
              </div>
            ) : (
              <>
                <div className="p-1">
                  {visibleItems.map(item => (
                    <div
                      key={item.value}
                      onClick={() => handleChange(item.value)}
                      className={cn(
                        'cursor-pointer px-3 py-1.5 text-sm rounded-md mx-1 my-[2px]',
                        'hover:bg-hover',
                        '!flex !flex-row !items-center !gap-3'
                      )}
                    >
                      <Check
                        className={cn(
                          'h-3 w-3 shrink-0',
                          selectedRepo && getRepositoryIdentity(selectedRepo) === item.value
                            ? 'opacity-100 text-primary'
                            : 'opacity-0'
                        )}
                      />
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    </div>
                  ))}
                </div>
                {/* Load more indicator */}
                {hasMoreItems && (
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
        </Command>
        <RepositorySelectorFooter
          onConfigureClick={handleIntegrationClick}
          onRefreshClick={handleRefreshCache}
          isRefreshing={isRefreshing}
        />
      </PopoverContent>
    </Popover>
  )
}
