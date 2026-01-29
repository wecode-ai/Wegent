// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo, useContext, useRef } from 'react'
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select'
import { FiGitBranch } from 'react-icons/fi'
import { Check } from 'lucide-react'
import { GitRepoInfo, GitBranch, TaskDetail } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { githubApis } from '@/apis/github'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { TaskContext } from '../../contexts/taskContext'
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
import { cn } from '@/lib/utils'

/**
 * BranchSelector component
 * Refer to RepositorySelector, internally fetches branch data, unified loading/empty/error states
 */
interface BranchSelectorProps {
  selectedRepo: GitRepoInfo | null
  selectedBranch: GitBranch | null
  handleBranchChange: (branch: GitBranch | null) => void
  disabled: boolean
  // Optional: pass task detail directly instead of using context
  taskDetail?: TaskDetail | null
  /** When true, display only icon without text (for responsive collapse) */
  compact?: boolean
}

export default function BranchSelector({
  selectedRepo,
  selectedBranch,
  handleBranchChange,
  disabled,
  taskDetail,
  compact = false,
}: BranchSelectorProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const isMobile = useIsMobile()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  // Used antd message.error for unified error prompt, no need for local error state
  const [error, setError] = useState<string | null>(null)
  const [userCleared, setUserCleared] = useState(false)
  const previousRepoIdRef = useRef<number | null>(null)
  // State for compact mode popover - must be declared before any conditional returns
  const [compactOpen, setCompactOpen] = React.useState(false)

  // Try to get context, but don't throw if not available
  const taskContext = useContext(TaskContext)
  const selectedTaskDetail = taskDetail ?? taskContext?.selectedTaskDetail ?? null

  // antd Select does not need dropdownDirection

  // Fetch branch list
  useEffect(() => {
    const currentRepoId = selectedRepo?.git_repo_id ?? null
    const previousRepoId = previousRepoIdRef.current
    const repoChanged = previousRepoId !== null && currentRepoId !== previousRepoId
    if (repoChanged) {
      handleBranchChange(null)
    }
    previousRepoIdRef.current = currentRepoId
    if (!selectedRepo) {
      setBranches([])
      setError(null)
      setLoading(false)

      return
    }
    let ignore = false
    setLoading(true)
    githubApis
      .getBranches(selectedRepo)
      .then(data => {
        if (!ignore) {
          setBranches(data)
          setError(null)
          setUserCleared(false)
        }
      })
      .catch(() => {
        if (!ignore) {
          setError(t('common:branches.load_failed'))
          toast({
            variant: 'destructive',
            title: t('common:branches.load_failed'),
          })
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo])

  // Automatically set branch based on selectedTask
  useEffect(() => {
    if (!branches || branches.length === 0) return
    if (userCleared) return
    if (selectedBranch?.name) {
      const foundBranch = branches.find(b => b.name === selectedBranch.name) || null
      if (
        foundBranch &&
        (foundBranch.default !== selectedBranch.default ||
          foundBranch.protected !== selectedBranch.protected)
      ) {
        handleBranchChange(foundBranch)
      }
      return
    }
    if (
      selectedTaskDetail &&
      'branch_name' in selectedTaskDetail &&
      selectedTaskDetail.branch_name
    ) {
      const foundBranch = branches.find(b => b.name === selectedTaskDetail.branch_name) || null
      if (foundBranch) {
        handleBranchChange(foundBranch)
        return
      }
    }
    // If there is no selectedTask or not found, select the default branch by default
    if (!selectedBranch) {
      const defaultBranch = branches.find(b => b.default)
      if (defaultBranch) {
        handleBranchChange(defaultBranch)
      } else {
        handleBranchChange(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, branches, userCleared])

  useEffect(() => {
    setUserCleared(false)
  }, [selectedRepo, selectedTaskDetail?.branch_name])

  // State merging
  const showLoading = loading
  const showError = !!error
  const showNoBranch = !showLoading && !showError && branches.length === 0

  // Convert branches to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    const items = branches.map(branch => ({
      value: branch.name,
      label: branch.name,
      searchText: branch.name,
      content: (
        <span>
          {branch.name}
          {branch.default && (
            <span className="ml-2 text-green-400 text-[10px]">{t('common:branches.default')}</span>
          )}
        </span>
      ),
    }))
    if (selectedBranch && !items.some(item => item.value === selectedBranch.name)) {
      items.unshift({
        value: selectedBranch.name,
        label: selectedBranch.name,
        searchText: selectedBranch.name,
        content: <span>{selectedBranch.name}</span>,
      })
    }
    return items
  }, [branches, selectedBranch, t])

  // Do not render (no branches, no selection, and no loading/error)
  if (!selectedBranch && branches.length === 0 && !showLoading && !showError) return null

  // Construct branch options
  const handleChange = (value: string) => {
    const branch = branches.find(b => b.name === value)
    if (branch) {
      setUserCleared(false)
      handleBranchChange(branch)
    }
  }

  // Tooltip content for branch selector
  // In compact mode, show selected branch name in tooltip
  const tooltipContent =
    compact && selectedBranch
      ? `${t('common:repos.branch_tooltip', '选择分支')}: ${selectedBranch.name}${selectedBranch.default ? ' (default)' : ''}`
      : t('common:repos.branch_tooltip', '选择分支')

  // In compact mode, use Popover directly instead of hidden SearchableSelect
  if (compact) {
    return (
      <div className="flex items-center min-w-0">
        <Popover open={compactOpen} onOpenChange={setCompactOpen}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled || showError || showNoBranch || showLoading}
                    className={cn(
                      'flex items-center gap-1 min-w-0 rounded-md px-2 py-1',
                      'transition-colors',
                      'text-text-muted hover:text-text-primary hover:bg-muted',
                      showLoading ? 'animate-pulse' : '',
                      'focus:outline-none focus:ring-0',
                      'disabled:cursor-not-allowed disabled:opacity-50'
                    )}
                  >
                    <FiGitBranch className="w-4 h-4 flex-shrink-0" />
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
              'p-0 w-auto min-w-[260px] max-w-[90vw] border border-border bg-base',
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
            <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
              <CommandInput
                placeholder={t('common:branches.search_branch')}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
                {showError ? (
                  <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
                ) : selectItems.length === 0 ? (
                  <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                    {showLoading
                      ? 'Loading...'
                      : showNoBranch
                        ? t('common:branches.no_branch')
                        : t('common:branches.select_branch')}
                  </CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                      {t('common:branches.no_match')}
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
                              selectedBranch?.name === item.value
                                ? 'opacity-100 text-primary'
                                : 'opacity-0 text-text-muted'
                            )}
                          />
                          {item.content ? (
                            <div className="flex-1 min-w-0">{item.content}</div>
                          ) : (
                            <span className="flex-1 min-w-0 truncate" title={item.label}>
                              {item.label}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <div className="flex items-center min-w-0">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex items-center gap-1 min-w-0 rounded-md px-2 py-1',
                'text-text-muted',
                showLoading ? 'animate-pulse' : ''
              )}
            >
              <FiGitBranch className="w-4 h-4 flex-shrink-0" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className="relative" style={{ width: isMobile ? 200 : 260 }}>
        <SearchableSelect
          value={selectedBranch?.name}
          onValueChange={handleChange}
          disabled={disabled || showError || showNoBranch || showLoading}
          placeholder={t('common:branches.select_branch')}
          searchPlaceholder={t('common:branches.search_branch')}
          items={selectItems}
          loading={showLoading}
          error={showError ? error : null}
          emptyText={
            showNoBranch ? t('common:branches.no_branch') : t('common:branches.select_branch')
          }
          noMatchText={t('common:branches.no_match')}
          triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
          contentClassName="max-w-[260px]"
          renderTriggerValue={item => {
            if (!item) return null
            const branch = branches.find(b => b.name === item.value)
            return (
              <span className="truncate">
                {item.label}
                {branch?.default && ' (default)'}
              </span>
            )
          }}
        />
      </div>
    </div>
  )
}
