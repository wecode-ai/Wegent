// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { useState, useMemo } from 'react'
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select'
import { FiGithub } from 'react-icons/fi'
import { Loader2, Check } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

import { truncateMiddle } from '@/utils/stringUtils'
import { RepositorySelectorProps, RepositorySelectItem } from './types'
import { RepositorySelectorFooter } from './RepositorySelectorFooter'
import { useRepositorySearch } from '../../hooks/useRepositorySearch'

/**
 * RepositorySelector component
 * Provides repository selection with search, caching, and refresh functionality
 */
export default function RepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail,
  fullWidth = false,
  compact = false,
}: RepositorySelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const isMobile = useIsMobile()

  // Use the custom hook for all repository search logic
  const {
    repos,
    loading,
    isSearching,
    isRefreshing,
    error,
    handleSearchChange,
    handleRefreshCache,
    handleChange,
  } = useRepositorySearch({
    selectedRepo,
    handleRepoChange,
    disabled,
    selectedTaskDetail,
  })

  // State for compact mode popover
  const [compactOpen, setCompactOpen] = useState(false)

  // Convert repos to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    const items: RepositorySelectItem[] = repos.map(repo => ({
      value: repo.git_repo_id.toString(),
      label: repo.git_repo,
      searchText: repo.git_repo,
    }))

    // Ensure selected repo is in the items list
    if (selectedRepo) {
      const hasSelected = items.some(item => item.value === selectedRepo.git_repo_id.toString())
      if (!hasSelected) {
        items.unshift({
          value: selectedRepo.git_repo_id.toString(),
          label: selectedRepo.git_repo,
          searchText: selectedRepo.git_repo,
        })
      }
    }

    return items
  }, [repos, selectedRepo])

  // Navigate to settings page to configure git integration
  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref())
  }

  // Tooltip content for repository selector
  const tooltipContent =
    compact && selectedRepo
      ? `${t('repos.repository_tooltip', '选择代码仓库')}: ${selectedRepo.git_repo}`
      : t('repos.repository_tooltip', '选择代码仓库')

  // Compact mode: use Popover with Command
  if (compact) {
    return (
      <div className="flex items-center min-w-0" data-tour="repo-selector">
        <Popover open={compactOpen} onOpenChange={setCompactOpen}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled || loading}
                    className={cn(
                      'flex items-center gap-1 min-w-0 rounded-md px-2 py-1',
                      'transition-colors',
                      'text-text-muted hover:text-text-primary hover:bg-muted',
                      loading ? 'animate-pulse' : '',
                      'focus:outline-none focus:ring-0',
                      'disabled:cursor-not-allowed disabled:opacity-50'
                    )}
                  >
                    <FiGithub className="w-4 h-4 flex-shrink-0" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{tooltipContent}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <PopoverContent
            className={cn(
              'p-0 w-auto min-w-[280px] max-w-[90vw] border border-border bg-base',
              'shadow-xl rounded-xl overflow-hidden',
              'max-h-[var(--radix-popover-content-available-height,400px)]',
              'flex flex-col'
            )}
            align="start"
            sideOffset={4}
            collisionPadding={8}
            avoidCollisions={true}
            sticky="partial"
          >
            <Command
              className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden"
              shouldFilter={false}
            >
              <CommandInput
                placeholder={t('branches.search_repository')}
                onValueChange={handleSearchChange}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
                {error ? (
                  <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
                ) : selectItems.length === 0 ? (
                  <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                    {loading ? 'Loading...' : t('branches.select_repository')}
                  </CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                      {t('branches.no_match')}
                    </CommandEmpty>
                    <CommandGroup>
                      {selectItems.map(item => (
                        <CommandItem
                          key={item.value}
                          value={item.searchText || item.label}
                          onSelect={() => {
                            handleChange(item.value)
                            setCompactOpen(false)
                          }}
                          className={cn(
                            'group cursor-pointer select-none',
                            'px-3 py-1.5 text-sm text-text-primary',
                            'rounded-md mx-1 my-[2px]',
                            'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                            'aria-selected:bg-hover',
                            '!flex !flex-row !items-start !gap-3'
                          )}
                        >
                          <Check
                            className={cn(
                              'h-3 w-3 shrink-0 mt-0.5 ml-1',
                              selectedRepo?.git_repo_id.toString() === item.value
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
            </Command>
            <RepositorySelectorFooter
              onConfigureClick={handleIntegrationClick}
              onRefreshClick={handleRefreshCache}
              isRefreshing={isRefreshing}
            />
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  // Normal mode: use SearchableSelect
  return (
    <div
      className={cn('flex items-center min-w-0', fullWidth && 'w-full')}
      data-tour="repo-selector"
      style={fullWidth ? undefined : { maxWidth: isMobile ? 200 : 280 }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex items-center gap-1 min-w-0 rounded-md px-2 py-1',
                'text-text-muted',
                loading ? 'animate-pulse' : ''
              )}
            >
              <FiGithub className="w-4 h-4 flex-shrink-0" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className={cn('relative flex items-center gap-2 min-w-0 flex-1', fullWidth && 'w-full')}>
        <SearchableSelect
          value={selectedRepo?.git_repo_id.toString()}
          onValueChange={handleChange}
          onSearchChange={handleSearchChange}
          disabled={disabled || loading}
          placeholder={t('branches.select_repository')}
          searchPlaceholder={t('branches.search_repository')}
          items={selectItems}
          loading={loading}
          error={error}
          emptyText={t('branches.select_repository')}
          noMatchText={t('branches.no_match')}
          className={fullWidth ? 'w-full' : undefined}
          triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
          contentClassName={fullWidth ? 'max-w-[400px]' : 'max-w-[280px]'}
          renderTriggerValue={item => (
            <span className="block" title={item?.label}>
              {item?.label ? truncateMiddle(item.label, fullWidth ? 60 : isMobile ? 20 : 25) : ''}
            </span>
          )}
          footer={
            <RepositorySelectorFooter
              onConfigureClick={handleIntegrationClick}
              onRefreshClick={handleRefreshCache}
              isRefreshing={isRefreshing}
            />
          }
        />
        {isSearching && (
          <Loader2 className="w-3 h-3 text-text-muted animate-spin flex-shrink-0 absolute right-0" />
        )}
      </div>
    </div>
  )
}
