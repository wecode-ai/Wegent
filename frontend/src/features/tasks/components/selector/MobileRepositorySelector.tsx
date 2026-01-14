// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useMemo } from 'react'
import { FolderGit2, Check } from 'lucide-react'
import { GitRepoInfo, TaskDetail } from '@/types/api'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

import { RepositorySelectorFooter } from './RepositorySelectorFooter'
import { useRepositorySearch } from '../../hooks/useRepositorySearch'

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

  // Use the shared repository search hook
  const {
    repos,
    loading,
    isRefreshing,
    error,
    handleSearchChange,
    handleRefreshCache,
    handleChange: baseHandleChange,
  } = useRepositorySearch({
    selectedRepo,
    handleRepoChange,
    disabled,
    selectedTaskDetail,
  })

  // Wrap handleChange to also close the popover
  const handleChange = (value: string) => {
    baseHandleChange(value)
    setOpen(false)
  }

  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref())
  }

  const selectItems = useMemo(() => {
    const items = repos.map(repo => ({
      value: repo.git_repo_id.toString(),
      label: repo.git_repo,
    }))

    if (selectedRepo) {
      const hasSelected = items.some(item => item.value === selectedRepo.git_repo_id.toString())
      if (!hasSelected) {
        items.unshift({
          value: selectedRepo.git_repo_id.toString(),
          label: selectedRepo.git_repo,
        })
      }
    }

    return items
  }, [repos, selectedRepo])

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          'p-0 w-[280px] border border-border bg-base',
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
                      value={item.label}
                      onSelect={() => handleChange(item.value)}
                      className={cn(
                        'cursor-pointer px-3 py-1.5 text-sm rounded-md mx-1 my-[2px]',
                        'data-[selected=true]:bg-primary/10 aria-selected:bg-hover',
                        '!flex !flex-row !items-center !gap-3'
                      )}
                    >
                      <Check
                        className={cn(
                          'h-3 w-3 shrink-0',
                          selectedRepo?.git_repo_id.toString() === item.value
                            ? 'opacity-100 text-primary'
                            : 'opacity-0'
                        )}
                      />
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
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
  )
}
